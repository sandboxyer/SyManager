import { execSync } from 'child_process';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import os from 'os';

class C {
  static #cacheDir = path.join(os.homedir(), '.c_runner_cache');
  static #compiler = 'gcc';
  static #logTime = false;
  static #forceRecompile = false;

  static config({ 
    logTime = false, 
    compiler = 'gcc',
    forceRecompile = false,
    cacheDir = null
  } = {}) {
    this.#logTime = logTime;
    this.#compiler = compiler;
    this.#forceRecompile = forceRecompile;
    if (cacheDir) this.#cacheDir = cacheDir;
  }

  static #initCache() {
    if (!fs.existsSync(this.#cacheDir)) {
      fs.mkdirSync(this.#cacheDir, { recursive: true, mode: 0o755 });
    }
  }

  static #getExecutablePath(tag) {
    return path.join(this.#cacheDir, `${tag}.out`);
  }

  static #compileAndSave(code, tag) {
    this.#initCache();
    const tempFile = path.join(this.#cacheDir, `${tag}.c`);
    const executable = this.#getExecutablePath(tag);

    try {
      fs.writeFileSync(tempFile, code, { mode: 0o644 });
      execSync(`${this.#compiler} ${tempFile} -o ${executable}`);
      fs.chmodSync(executable, 0o755);
      fs.unlinkSync(tempFile);
      return executable;
    } catch (err) {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      throw new Error(`Compilation failed: ${err.message}`);
    }
  }

  static #execute(executable, args = []) {
    const start = Date.now();
    try {
      const argString = args.map(arg => 
        typeof arg === 'string' ? `"${arg.replace(/"/g, '\\"')}"` : arg.toString()
      ).join(' ');

      const output = execSync(`${executable} ${argString}`).toString();

      if (this.#logTime) {
        console.log(`Execution time: ${Date.now() - start}ms`);
      }
      return output;
    } catch (err) {
      throw new Error(`Execution failed: ${err.message}`);
    }
  }

  static run(code, { 
    args = [], 
    tag = null, 
    force = false 
  } = {}) {
    if (!tag) {
      const tempTag = `temp_${crypto.randomBytes(4).toString('hex')}`;
      const executable = this.#compileAndSave(code, tempTag);
      const result = this.#execute(executable, args);
      fs.unlinkSync(executable);
      return result;
    }

    const executable = this.#getExecutablePath(tag);
    if (force || this.#forceRecompile || !fs.existsSync(executable)) {
      this.#compileAndSave(code, tag);
    }
    return this.#execute(executable, args);
  }

  static removeTag(tag) {
    const executable = this.#getExecutablePath(tag);
    if (fs.existsSync(executable)) {
      fs.unlinkSync(executable);
      return true;
    }
    return false;
  }

  static clearCache() {
    if (fs.existsSync(this.#cacheDir)) {
      fs.rmSync(this.#cacheDir, { recursive: true });
    }
  }
}

export default C