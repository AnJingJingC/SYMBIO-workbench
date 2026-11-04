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
