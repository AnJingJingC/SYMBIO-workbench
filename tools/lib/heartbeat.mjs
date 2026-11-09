// tools/lib/heartbeat.mjs —— 活动心跳（亮灯的**唯一数据源**）
//
// 为什么要它：作者的"亮灯"是「谁被唤醒、谁在思考，就亮起来」。我们原来只有一块常亮的
// 在线灯，那不叫亮灯，那叫"电源指示灯"。亮灯的前提是**有实时活动信号**。
//
// 落盘方案：一场景一文件 memory/10-shared/心跳/<scene>.json
//   · 为什么不是单文件汇总：多个进程（autopilot / bus / route）会同时写，
//     单文件读-改-写必然互相覆盖（最后写的赢，别人的灯就灭了）。
//     一场景一文件，写者互不干扰，读的时候扫目录合并。
//   · 为什么带 ttlMs：灯必须会自己灭。超时未续期的活动是**陈旧噪音**，
//     不是"还在思考"——宁可灯灭，也不假装它还在干活。

import fs from 'node:fs/promises';
import path from 'node:path';
import { root, ensureDir, readJson, writeJsonAtomic, nowStamp } from './common.mjs';

export const HEARTBEAT_DIR = 'memory/10-shared/心跳';
export const DEFAULT_TTL_MS = 90_000;

/** 面板与 CLI 共用的阶段词表。改这里就等于改全系统的灯语义。 */
export const PHASES = {
  wake: '唤醒',
  think: '思考中',
  intake: '摄入',
  card: '落卡',
  dispatch: '派单',
  receipt: '回执',
  idle: '空闲',
};

/**
 * 写一次心跳。fire-and-forget：心跳失败绝不能影响主流程（灯灭可以，活不能停）。
 * @param {{scene?:string, phase?:keyof PHASES|string, detail?:string, ttlMs?:number, rootDir?:string}} o
 */
export async function beat({ scene = 'shared', phase = 'idle', detail = '', ttlMs = DEFAULT_TTL_MS, rootDir = null } = {}) {
  const home = rootDir || root();
  const file = path.join(home, HEARTBEAT_DIR, `${scene}.json`);
  const stamp = nowStamp();
  const record = {
    scene,
    phase,
    phaseLabel: PHASES[phase] ?? phase,
    detail: String(detail ?? '').slice(0, 120),
    at: stamp.iso,
    atLocal: `${stamp.date} ${stamp.time}`,
    ttlMs,
  };
  try {
    await ensureDir(path.dirname(file));
    await writeJsonAtomic(file, record);
    // 写的时候顺手清掉别人留下的过期文件：否则「最后一个心跳过期」永远没人管，
    // 面板上「N 个心跳已过期」就成了常态。放在这里而不是只在个别工具里调，
    // 是因为写心跳的入口会越来越多（bus / route / autopilot / 未来任何工具），
    // 清理只挂在其中几个上，漏掉的那些就会默默攒垃圾。
    // 自己刚写的这份是新鲜的，不会被删。
    await pruneBeats({ rootDir: home });
    return record;
  } catch {
    return null;
  }
}

/**
 * 读全部心跳，剔除过期项。
 * @returns {Promise<{beats:Array<object>, active:Array<object>, stale:number, available:boolean}>}
 */
export async function readBeats({ rootDir = null, now = Date.now() } = {}) {
  const home = rootDir || root();
  const dir = path.join(home, HEARTBEAT_DIR);
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch (error) {
    // 目录不存在 = 还没有任何活动（正常），不是读不到（异常）
    return { beats: [], active: [], stale: 0, available: error?.code !== 'ENOENT' ? false : true };
  }

  const beats = [];
  let stale = 0;
  for (const name of names) {
    const rec = await readJson(path.join(dir, name));
    if (!rec || !rec.scene || !rec.at) continue;
    const age = now - Date.parse(rec.at);
    const ttl = Number(rec.ttlMs) > 0 ? Number(rec.ttlMs) : DEFAULT_TTL_MS;
    if (!Number.isFinite(age) || age > ttl) {
      stale += 1;
      continue;
    }
    beats.push({ ...rec, ageMs: Math.max(0, age), remainMs: Math.max(0, ttl - age) });
  }
  beats.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { beats, active: beats.filter((b) => b.phase !== 'idle'), stale, available: true };
}

/** 让某个场景的灯立刻灭掉（工序结束时调用，不用等 TTL）。 */
export async function clearBeat({ scene, rootDir = null } = {}) {
  const home = rootDir || root();
  try {
    await fs.unlink(path.join(home, HEARTBEAT_DIR, `${scene}.json`));
    return true;
  } catch {
    return false;
  }
}

/**
 * 清掉**已过期**的心跳文件，返回删掉的条数。
 *
 * 为什么需要：心跳文件只会过期、从来不会被删除，于是 `stale` 计数只增不减——
 * 面板上那句「N 个心跳已过期」会永久挂着，越用越多，最后变成噪音。
 * 过期的文件本来就不计入 active，删掉它不影响任何判断，只是不再唠叨。
 *
 * 只删 `age > ttl` 的：新鲜的心跳哪怕 phase 是 idle 也一律不动（它可能就是
 * 别人刚留下的痕迹）。读不出来的坏文件一并清掉——它永远不会变成有效心跳。
 */
export async function pruneBeats({ rootDir = null, now = Date.now() } = {}) {
  const home = rootDir || root();
  const dir = path.join(home, HEARTBEAT_DIR);
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch {
    return 0;
  }

  let removed = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    const rec = await readJson(file);
    const age = rec?.at ? now - Date.parse(rec.at) : NaN;
    const ttl = Number(rec?.ttlMs) > 0 ? Number(rec.ttlMs) : DEFAULT_TTL_MS;
    const expired = !rec || !Number.isFinite(age) || age > ttl;
    if (!expired) continue;
    try {
      await fs.unlink(file);
      removed += 1;
    } catch {
      /* 删不掉就算了，灯的事不能拖住活 */
    }
  }
  return removed;
}
