// JobRunner: the long tasks a project runs (exports, cutdowns) and the status the player polls while they run.
// Each kind of task has a lane that runs one task at a time. Locally a task is a child process on this computer;
// a hosted edition can implement the same lanes over a job queue and render workers.
//
//   createJobRunner({ export: blank, cutdown: blank })  one lane per name; blank is its idle status
//   lane.status          the status the player sees: { state: 'idle' | 'running' | 'done' | 'error', pct, line, … }
//   lane.running         a task is running
//   lane.begin(fields)   start a task: a fresh running status (pct 0) with these fields
//   lane.set(patch)      update the status (progress, a new line, done, error)
//   lane.reset(fields)   back to idle (or to fields over the idle status, e.g. an error before anything ran)
//   lane.attach(child)   the process doing the work, so stop() can end it; let go of when it exits
//   lane.stop(signal)    end the running process, if there is one
//   runner.stopAll()     stop every lane (the server is closing)
//
// runTracked(lane, cmd, args, opts) runs a process for a lane and turns its output into progress.

import { spawn } from 'node:child_process';
import { lastLine } from './media.mjs';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function makeLane(blank) {
  let status = { ...blank };
  let child = null;
  return {
    get status() {
      return status;
    },
    get running() {
      return status.state === 'running';
    },
    begin(fields = {}) {
      status = { ...blank, pct: 0, ...fields, state: 'running' };
      return status;
    },
    set(patch) {
      Object.assign(status, patch);
      return status;
    },
    reset(fields = {}) {
      status = { ...blank, ...fields };
      return status;
    },
    attach(c) {
      child = c;
      c.on('close', () => {
        if (child === c) child = null;
      });
      return c;
    },
    stop(signal) {
      child?.kill(signal);
    },
  };
}

export function createJobRunner(blanks) {
  const lanes = Object.fromEntries(Object.entries(blanks).map(([name, blank]) => [name, makeLane(blank)]));
  return {
    ...lanes,
    stopAll() {
      for (const l of Object.values(lanes)) l.stop();
    },
  };
}

/**
 * Run cmd for a lane; resolves when it exits with 0, else rejects with its last line of output.
 *   seconds: ffmpeg run with -progress pipe:1 — its out_time_us over this many seconds is the lane's pct (0–99)
 *   onOutput(text): every chunk of stdout and stderr, for a process that reports progress its own way
 *   what: names the process in the error when it says nothing ('ffmpeg')
 */
export function runTracked(lane, cmd, args, { env, cwd, seconds = 0, onOutput = null, what = 'ffmpeg' } = {}) {
  return new Promise((resolve, reject) => {
    const child = lane.attach(spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] }));
    let tail = '';
    child.stdout.on('data', (d) => {
      if (onOutput) {
        tail = (tail + d).slice(-4000);
        return onOutput(String(d));
      }
      // -progress pipe:1 prints "out_time_us=12345" lines
      const m = seconds > 0 && [...String(d).matchAll(/out_time_us=(\d+)/g)].pop();
      if (m) lane.set({ pct: clamp((Number(m[1]) / 1e6 / seconds) * 100, 0, 99) });
    });
    child.stderr.on('data', (d) => {
      tail = (tail + d).slice(-4000);
      onOutput?.(String(d));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(lastLine(tail) || `${what} exited with code ${code}`));
    });
  });
}
