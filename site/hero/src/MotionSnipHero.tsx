import { Bar, Button, Caret, Check, Collapse, Roll, Spinner, Stage, Text, Window, box, type Act, type Point } from './kit'
import './hero.css'

// MotionSnip Studio's landing hero: fix a headline in place, circle a problem
// on the frame, send it to Claude, and watch v2 come back with both done.

type S = {
  selected: boolean
  editing: boolean
  headline: string
  edited: boolean
  note: { show: boolean; at: Point }
  typed: string
  ring: boolean
  pinned: boolean
  changes: number
  waiting: boolean
  terminal: boolean
  lines: number
  v2: boolean
  flash: boolean
}

const OLD = 'Meet Acme'
const NEW = 'Say hi to Acme'
const NOTE = 'Make the logo bigger'

const initial: S = {
  selected: false,
  editing: false,
  headline: OLD,
  edited: false,
  note: { show: false, at: { x: 0, y: 0 } },
  typed: '',
  ring: false,
  pinned: false,
  changes: 0,
  waiting: false,
  terminal: false,
  lines: 0,
  v2: false,
  flash: false,
}

// The frame people see first: v2 is in, both changes ticked off
const POSTER: S = { ...initial, headline: NEW, changes: 2, v2: true }

const REST = { wide: { x: 560, y: 470 }, compact: { x: 236, y: 236 } }

async function script(a: Act<S>) {
  const compact = a.layout === 'compact'
  await a.wait(500)

  // 1. Fix the headline in place
  await a.move({ at: 'headline', x: 0.9, y: 0.7 })
  await a.set({ selected: true })
  await a.wait(250)
  await a.click({ at: 'headline', x: 0.9, y: 0.7 }, { double: true })
  await a.set({ editing: true, headline: '' })
  await a.wait(150)
  await a.type('headline', NEW, { interval: 55 })
  await a.wait(250)
  await a.key('enter')
  await a.set({ editing: false, selected: false, edited: true, changes: 1 })
  await a.wait(500)

  // 2. Circle the logo and say what's wrong
  await a.move({ at: 'logo', x: 0.7, y: 0.6 })
  await a.wait(200)
  await a.click({ at: 'logo', x: 0.7, y: 0.6 }, { right: true })
  const logo = a.rect('logo')
  const noteW = compact ? 200 : 236
  const noteX = compact ? 358 - 16 - noteW : logo.x + logo.width + 26
  await a.set({ ring: true, note: { show: true, at: { x: noteX, y: logo.y + (compact ? 22 : -4) } }, typed: '' })
  await a.wait(450)
  await a.type('typed', NOTE, { interval: 45 })
  await a.wait(250)
  await a.key('enter')
  await a.set((s) => ({ note: { ...s.note, show: false }, pinned: true, changes: 2 }))
  await a.wait(600)

  // 3. Send it to Claude
  await a.move({ at: 'send', x: 0.82, y: 0.62 })
  await a.wait(250)
  await a.click({ at: 'send', x: 0.82, y: 0.62 })
  await a.set({ waiting: true })
  await a.wait(350)
  await a.move('rest')
  await a.set({ terminal: true })
  await a.wait(700)
  await a.stagger([1, 2, 3, 4], (n) => a.set({ lines: n }), 420)
  await a.wait(900)

  // 4. v2 is in: the player comes back, both changes landed
  await a.set({ terminal: false })
  await a.wait(250)
  await a.set({ waiting: false, v2: true, flash: true, edited: false, ring: false, pinned: false })
  await a.wait(1200)
  await a.set({ flash: false })
  await a.wait(compact ? 1800 : 2000)

  // Back to the opening frame: the last change first, one motion
  await a.set({ v2: false, changes: 0, lines: 0 })
  await a.wait(80)
  await a.set({ ...initial })
  await a.wait(500)
}

export function MotionSnipHero() {
  return (
    <Stage
      width={1000}
      height={640}
      compact={{ below: 720, width: 358, height: 340 }}
      theme="dark"
      initial={initial}
      poster={POSTER}
      script={script}
      cursor={{ at: REST }}
      className="msh"
    >
      {(s, rect, layout) => (
        <>
          <Window url="localhost:4321" className="msh-win" data-back={s.terminal || undefined}>
            <div className="msh-app">
              <header className="msh-top">
                <span className="msh-mark" aria-hidden>
                  <svg viewBox="0 0 48 48" width="22" height="22"><rect x="3" y="10" width="42" height="28" rx="6" fill="currentColor" /><circle cx="35.5" cy="19" r="4.6" fill="var(--cue)" /></svg>
                </span>
                <span className="msh-title">Acme launch</span>
                <span className="msh-ver">
                  <Roll>{s.v2 ? 'v2' : 'v1'}</Roll>
                </span>
                {layout === 'wide' && <Bar w={92} h={22} r={11} tone={2} className="msh-pill" />}
                <span className="msh-spacer" />
                {layout === 'wide' && <Bar w={70} h={28} r={7} tone={2} />}
                <Button
                  variant="primary"
                  className="msh-send"
                  data-target="send"
                  icon={s.waiting ? <Spinner /> : undefined}
                >
                  {s.waiting ? 'Waiting for v2' : 'Send to Claude'}
                </Button>
              </header>

              <div className="msh-body">
                <div className="msh-stagecol">
                  <div className="msh-frame">
                    <div className="msh-video">
                      <div className="msh-logo" data-target="logo" data-big={s.v2 || undefined} data-cursor="pointer">
                        <span className="msh-logo__dot" />acme
                      </div>
                      <div
                        className="msh-headline"
                        data-target="headline"
                        data-cursor={s.editing ? 'ibeam' : 'pointer'}
                        data-selected={s.selected || undefined}
                        data-editing={s.editing || undefined}
                      >
                        <span className="msh-headline__text" data-snap>{s.headline || '​'}</span>
                        {s.editing && <Caret />}
                        <span className="msh-tag" aria-hidden>Headline</span>
                        <span className="msh-tape" data-show={s.edited || undefined}>Waiting for Claude</span>
                      </div>
                      <div className="msh-sub" aria-hidden>
                        <i style={{ width: 230 }} />
                        <i style={{ width: 160 }} />
                      </div>
                      {/* the product shot the launch video is about */}
                      <div className="msh-product" aria-hidden>
                        <i className="msh-product__img" />
                        <i style={{ width: '70%' }} />
                        <i style={{ width: '48%' }} />
                        <i className="msh-product__btn" />
                      </div>
                      <span className="msh-cue" data-go={s.flash || undefined} aria-hidden />
                    </div>
                  </div>

                  <div className="msh-transport">
                    <span className="msh-play" aria-hidden>
                      <svg viewBox="0 0 12 12" width="12" height="12"><path d="M3.5 2.2v7.6L10 6z" fill="currentColor" /></svg>
                    </span>
                    <span className="msh-tc">00:01.2</span>
                    <span className="msh-tc msh-tc--faint">/ 00:12.0</span>
                  </div>
                  <div className="msh-lanes">
                    <div className="msh-lane msh-scenes">
                      <span data-on>S1 Hook</span>
                      <span>S2 Product</span>
                      <span>S3 Outro</span>
                      <i className="msh-head" />
                      <i className="msh-pin" data-show={s.pinned || undefined} />
                    </div>
                    <div className="msh-lane msh-wave" aria-hidden>
                      <div>{WAVE.map((h, i) => <i key={i} style={{ height: h }} />)}</div>
                    </div>
                    <div className="msh-lane msh-wave msh-wave--fx" aria-hidden>
                      <div>{WAVE.map((h, i) => <i key={i} style={{ height: i % 13 < 2 ? h : 2 }} />)}</div>
                    </div>
                  </div>
                </div>

                {layout === 'wide' && (
                  <aside className="msh-panel">
                    <div className="msh-tabs">
                      <span>Edit</span>
                      <span>Script</span>
                      <span>Sound</span>
                      <span data-on>
                        Changes
                        <span className="msh-count" data-show={s.changes > 0 || undefined}>
                          <Roll>{String(Math.max(1, s.changes))}</Roll>
                        </span>
                      </span>
                    </div>
                    <div className="msh-changes">
                      <div className="msh-status">
                        <Roll variant="fade">{s.v2 ? 'v2 is in · 2 of 2 applied' : s.changes ? `${s.changes} ${s.changes === 1 ? 'change' : 'changes'} ready` : 'Nothing changed yet'}</Roll>
                      </div>
                      <Collapse open={s.changes >= 1}>
                        <ChangeRow done={s.v2} kind="tape" title="Headline" detail={`${OLD} → ${NEW}`} />
                      </Collapse>
                      <Collapse open={s.changes >= 2}>
                        <ChangeRow done={s.v2} kind="ring" title="Note · 00:01.2" detail={NOTE} />
                      </Collapse>
                    </div>
                    <div className="msh-scenelist">
                      <div className="msh-scenelist__head">Scenes</div>
                      <div className="msh-srow">
                        <i data-tone="pink" />
                        <span>S1 Hook</span>
                        <span className="msh-srow__meta">
                          <Roll variant="fade">{s.v2 ? 'Check v2' : s.changes ? 'Needs changes' : 'Review'}</Roll>
                        </span>
                      </div>
                      <div className="msh-srow">
                        <i data-tone="ok" />
                        <Bar w={74} h={6} tone={2} />
                        <span className="msh-srow__meta">Approved</span>
                      </div>
                      <div className="msh-srow">
                        <i />
                        <Bar w={58} h={6} tone={2} />
                        <Bar w={44} h={6} tone={1} />
                      </div>
                    </div>
                  </aside>
                )}
              </div>
            </div>
          </Window>

          {/* The drawn ring and its note, placed from the logo's measured box */}
          <svg className="msh-ring" data-show={s.ring || undefined} style={box(ringBox(rect('logo')))} viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden>
            <path pathLength={1} d="M78 9C64 2 25 3 11 15 0 25 6 47 30 53c20 5 52 2 63-12 8-11 3-25-14-31" />
          </svg>
          <span className="msh-num" data-show={s.pinned || undefined} style={{ left: rect('logo').x + rect('logo').width + 4, top: rect('logo').y - 14 }}>1</span>

          <div className="msh-note" data-show={s.note.show || undefined} style={{ left: s.note.at.x, top: s.note.at.y }}>
            <div className="msh-note__head">Note · 00:01.2</div>
            <div className="msh-note__field" data-cursor="ibeam">
              <span className="msh-note__ph" data-hide={s.typed ? true : undefined}>{layout === 'compact' ? 'What should change?' : 'What should change here?'}</span>
              {s.typed}
              {s.note.show && <Caret />}
            </div>
            <div className="msh-note__foot">Enter saves</div>
          </div>

          <Window chrome="terminal" title="acme-launch — claude" className="msh-term" data-show={s.terminal || undefined}>
            <div className="msh-cmd">Apply the MotionSnip Studio feedback in .motionsnip/feedback-v1.md</div>
            <Collapse open={s.lines >= 1}><div className="msh-out"><b>✓</b> Headline text <span className="dim">src/Hook.tsx:12</span></div></Collapse>
            <Collapse open={s.lines >= 2}><div className="msh-out"><b>✓</b> Logo size <span className="dim">src/Hook.tsx:8</span></div></Collapse>
            <Collapse open={s.lines >= 3}><div className="msh-out"><b>✓</b> Rendered <span className="dim">out/video.mp4</span></div></Collapse>
            <Collapse open={s.lines >= 4}><div className="msh-out"><b>✓</b> reel.json is now v2</div></Collapse>
          </Window>

          <span data-target="rest" style={{ position: 'absolute', left: REST[layout].x, top: REST[layout].y }} />
        </>
      )}
    </Stage>
  )
}

// The ring is drawn loose around the spot, the way a director circles it
function ringBox(r: { x: number; y: number; width: number; height: number }) {
  return { x: r.x - 14, y: r.y - 13, width: r.width + 30, height: r.height + 26 }
}

function ChangeRow({ done, kind, title, detail }: { done: boolean; kind: 'tape' | 'ring'; title: string; detail: string }) {
  return (
    <div className="msh-row">
      <span className="msh-row__lead" data-kind={kind} aria-hidden>
        {kind === 'ring' ? (
          <svg viewBox="0 0 20 16" width="18" height="14"><path d="M15 3C12 1 5 1 2.6 4.4 1 7 2.4 12 8 13c4.4.8 9-.6 9.6-3.6.5-2.4-1-4.6-4.6-5.4" /></svg>
        ) : (
          <i />
        )}
      </span>
      <span className="msh-row__text">
        <Text className="msh-row__title">{title}</Text>
        <Text className="msh-row__detail">{detail}</Text>
      </span>
      <Check on={done} />
    </div>
  )
}

// A soft music waveform: louder after the drop
const WAVE = Array.from({ length: 96 }, (_, i) => {
  const drop = i > 30 ? 1 : 0.55
  const v = 0.35 + 0.65 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.37))
  return Math.round(4 + 18 * v * drop)
})
