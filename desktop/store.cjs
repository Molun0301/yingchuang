const fs = require('node:fs');
const path = require('node:path');
const { model, migrateStorage } = require('./projects.cjs');

class Store {
  constructor(folder) {
    this.file = path.join(folder, '映窗.json');
    fs.mkdirSync(folder, { recursive: true });
    this.data = { version: 2, favorites: [], projects: {}, templates: [], builds: [],
      settings: { roots: [], outputDirectory: '', deviceId: 'xiaomi-18-pro-max' } };
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const migrate = saved.version === 1;
      this.data = { ...this.data, ...(migrate ? migrateStorage(saved) : saved),
        settings: { ...this.data.settings, ...saved.settings } };
      if(migrate)this.save();
    }
  }
  save() {
    const temp = this.file + '.writing';
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(temp, this.file);
  }
  snapshot() {
    const { favorites, templates, settings } = this.data;
    return structuredClone({ favorites, templates: [...model.builtinTemplates(), ...templates], settings });
  }
  update(callback) { callback(this.data); this.save(); return this.snapshot(); }
}
module.exports = { Store };
