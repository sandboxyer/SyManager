import fs from 'fs';
import path from 'path';

class ConfigManager {
    static configPath = path.join(process.cwd(), 'config.json');

    static loadConfig() {
        // Check if the config file exists
        if (!fs.existsSync(this.configPath)) {
            return {};
        } else {
            // If it exists, load and return the config object
            return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        }
    }

    static getConfig() {
        return this.loadConfig();
    }

    static updateConfig(newConfig) {
        // Read the existing config, merge with newConfig, and write back
        const config = this.loadConfig();
        const updatedConfig = { ...config, ...newConfig };
        fs.writeFileSync(this.configPath, JSON.stringify(updatedConfig, null, 2));  // Pretty print JSON
        return updatedConfig;
    }

    static setKey(key, value) {
        // Set a specific key-value pair in the config
        const config = this.loadConfig();
        config[key] = value;
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));  // Pretty print JSON
    }

    static getKey(key) {
        // Get a specific value by key from the config
        const config = this.loadConfig();
        return config[key];
    }

    static deleteKey(key) {
        // Delete a specific key-value pair from the config
        const config = this.loadConfig();
        delete config[key];
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));  // Pretty print JSON
    }

    static getAllKeys() {
        // Return an array of all keys in the config
        const config = this.loadConfig();
        return Object.keys(config);
    }
}

export default ConfigManager