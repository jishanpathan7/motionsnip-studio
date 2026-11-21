// JobRunner: the long tasks a project runs (exports, cutdowns) and the status the player polls while they run.
// Each kind of task has a lane that runs one task at a time. Locally a task is a child process on this computer;
// a hosted edition can implement the same lanes over a job queue and render workers.
//
//   createJobRunner({ export: blank, cutdown: blank })  one lane per name; blank is its idle status
//   lane.status          the status the player sees: { state: 'idle' | 'running' | 'done' | 'error', pct, line, job, … }
//   lane.running         a task is running
//   lane.job             the current (or last) job
//   lane.begin(fields)   start a task, synchronously (call it before the first await so two requests can't both
//                        start): a fresh running status (pct 0) with these fields. Throws when a task is running.
//                        Returns the task's job handle:
//
//   job.id               its id, also in the status (status.job)
//   job.set(patch)       update its status (progress, a new line); ignored once it has ended
//   job.attach(child, { group })  a process doing its work: stopped when the job stops or ends without
//                        succeeding; group: the child leads a process group (spawned detached) and the whole
//                        group is stopped, so a shell's own children go too
//   job.cleanup(fn)      fn(ok) runs once when the job ends, however it ends (temp files, half-made output)
//   job.done(patch)      it worked: state 'done'
//   job.fail(line, patch) it didn't: state 'error'
//   job.cancel(fields)   back to idle (or fields over the idle status)
//   job.abort()          it never really started (a refused request): the status goes back to how it was
//   job.stop(signal)     stop its processes without ending it (it ends when they exit)
//
// done, fail, cancel and abort end the job once and return true; later calls return false. A job changes the
// lane's status only while it is the lane's current job, so a slow request that finishes after its job was
// replaced can't touch the next job.
//
//   runner.stopAll()     stop and clean up every running job (the server is closing)
//
// runTracked(job, cmd, args, opts) runs a process for a job and turns its output into progress.

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { lastLine } from './media.mjs';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function kill(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.group && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* the group is gone: fall through to the child itself */
    }
  }
  child.kill(signal);
}

function makeLane(blank) {
  let status = { ...blank };
  let current = null;

  const lane = {
    get status() {
      return status;
    },
    get running() {
      return status.state === 'running';
    },
    get job() {
      return current;
    },
    begin(fields = {}) {
      if (lane.running) throw new Error('This lane is busy: one task at a time');
      const before = status;
      const id = crypto.randomBytes(6).toString('hex');
      const children = new Set();
      const cleanups = [];
      let view = { ...blank, pct: 0, ...fields, state: 'running', job: id };
      let ended = false;

      const end = (ok, next) => {
        if (ended) return false;
        ended = true;
        if (!ok) job.stop('SIGKILL');
        for (const fn of cleanups.splice(0)) {
          try {
            fn(ok);
          } catch {
            /* a clean-up that fails doesn't stop the others */
          }
        }
        view = next(view);
        if (current === job) status = view;
        return true;
      };

      const job = {
        id,
        get ended() {
          return ended;
        },
        get current() {
          return current === job;
        },
        get status() {
          return view;
        },
        set(patch) {
          if (!ended) Object.assign(view, patch);
          return view;
        },
        attach(child, { group = false } = {}) {
          child.group = group;
          children.add(child);
          child.on('close', () => children.delete(child));
          if (ended) kill(child, 'SIGKILL'); // the job is over: its work isn't wanted
          return child;
        },
        cleanup(fn) {
          cleanups.push(fn);
        },
        stop(signal) {
          for (const c of children) kill(c, signal);
        },
        done(patch = {}) {
          return end(true, (v) => Object.assign(v, patch, { state: 'done' }));
        },
        fail(line, patch = {}) {
          return end(false, (v) => Object.assign(v, patch, { state: 'error', line: String(line || 'Failed') }));
        },
        cancel(fields = {}) {
          return end(false, () => ({ ...blank, ...fields }));
        },
        abort() {
          return end(false, () => before);
        },
      };
      current = job;
      status = view;
      return job;
    },
  };
  return lane;
}

export function createJobRunner(blanks) {
  const lanes = Object.fromEntries(Object.entries(blanks).map(([name, blank]) => [name, makeLane(blank)]));
  return {
    ...lanes,
    stopAll() {
      for (const l of Object.values(lanes)) if (l.job && !l.job.ended) l.job.fail('Stopped: the player closed');
    },
  };
}

/**
 * Run cmd for a job; resolves when it exits with 0, else rejects with its last line of output.
 *   seconds: ffmpeg run with -progress pipe:1 — its out_time_us over this many seconds is the job's pct (0–99)
 *   onOutput(text): every chunk of stdout and stderr, for a process that reports progress its own way
 *   what: names the process in the error when it says nothing ('ffmpeg')
 *   group: run it as its own process group, so stopping the job stops what it started too (a shell command)
 */
export function runTracked(job, cmd, args, { env, cwd, seconds = 0, onOutput = null, what = 'ffmpeg', group = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = job.attach(spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: group }), { group });
    let tail = '';
    child.stdout.on('data', (d) => {
      if (onOutput) {
        tail = (tail + d).slice(-4000);
        return onOutput(String(d));
      }
      // -progress pipe:1 prints "out_time_us=12345" lines
      const m = seconds > 0 && [...String(d).matchAll(/out_time_us=(\d+)/g)].pop();
      if (m) job.set({ pct: clamp((Number(m[1]) / 1e6 / seconds) * 100, 0, 99) });
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
