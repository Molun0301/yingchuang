const fs = require('node:fs');
const path = require('node:path');
const { builtinTemplates } = require('./model.cjs');

class Store {
  constructor(folder) {
    this.file = path.join(folder, '映窗.json');
    fs.mkdirSync(folder, { recursive: true });
    this.data = { version: 1, favorites: [], drafts: {}, templates: [],
      settings: { roots: [], outputDirectory: '', deviceId: 'xiaomi-18-pro-max' } };
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...saved, settings: { ...this.data.settings, ...saved.settings } };
    }
  }
  save() {
    const temp = this.file + '.writing';
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(temp, this.file);
  }
  snapshot() { return structuredClone({ ...this.data, templates: [...builtinTemplates(), ...this.data.templates] }); }
  update(callback) { callback(this.data); this.save(); return this.snapshot(); }
}
module.exports = { Store };
