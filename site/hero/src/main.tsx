import { createRoot } from 'react-dom/client'
import { MotionSnipHero } from './MotionSnipHero'

// Mounts the animated hero over the static screenshot in #hero-stage.
const host = document.getElementById('hero-stage')
if (host) {
  host.dataset.live = ''
  createRoot(host).render(<MotionSnipHero />)
}
