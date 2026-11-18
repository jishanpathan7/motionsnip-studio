// The server half of the example add-on: one route, GET /api/addons/hello/info.
import fs from 'node:fs';
import path from 'node:path';

export default function setup(addon) {
  addon.route('GET', 'info', (req, res) => {
    const dir = addon.helpers.projectDir();
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
    addon.helpers.sendJson(res, 200, { project: path.basename(dir), files: files.length });
  });
}
