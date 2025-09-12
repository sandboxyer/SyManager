import readline from 'readline';
import { stdin, stdout } from 'process';

class TerminalHUD {
    constructor(config = {}) {
        this.rl = readline.createInterface({
            input: stdin,
            output: stdout
        });
        this.loading = false;
        this.numberedMenus = config.numberedMenus || false;
        this.highlightColor = this.getAnsiBackgroundColor(config.highlightColor || 'blue');
        this.lastMenuGenerator = null;
        this.lastSelectedIndex = 0;
        this.refreshCallbacks = new Set();
        this.refreshInterval = config.refreshInterval || 2000;
        this.refreshIntervalId = null;
        this.currentQuestion = null;
    }

    // Helper methods
    getAnsiBackgroundColor(color) {
        const colors = {
            red: '\x1b[41m', green: '\x1b[42m', yellow: '\x1b[43m',
            blue: '\x1b[44m', magenta: '\x1b[45m', cyan: '\x1b[46m',
            white: '\x1b[47m'
        };
        return colors[color] || '';
    }

    resetColor() {
        return '\x1b[0m';
    }

    startLoading() {
        this.loading = true;
        let i = 0;
        this.loadingInterval = setInterval(() => {
            stdout.clearLine();
            stdout.cursorTo(0);
            stdout.write(`⏳ Loading${'.'.repeat(i)}`);
            i = (i + 1) % 4;
        }, 500);
    }

    stopLoading() {
        this.loading = false;
        clearInterval(this.loadingInterval);
        stdout.clearLine();
        stdout.cursorTo(0);
    }

    // Refresh management
    startAutoRefresh() {
        if (this.refreshIntervalId) return;
        this.refreshIntervalId = setInterval(() => {
            this.triggerRefresh();
        }, this.refreshInterval);
    }

    stopAutoRefresh() {
        if (this.refreshIntervalId) {
            clearInterval(this.refreshIntervalId);
            this.refreshIntervalId = null;
        }
    }

    triggerRefresh() {
        for (const cb of this.refreshCallbacks) {
            cb();
        }
    }

    onRefresh(callback) {
        this.refreshCallbacks.add(callback);
        return () => this.refreshCallbacks.delete(callback);
    }

    // Input handling
    async ask(question, config = {}) {
        this.currentQuestion = { question, config };
        
        if (config.options) {
            return this.numberedMenus 
                ? this.displayMenuFromOptions(question, config.options, config)
                : this.displayMenuWithArrows(question, config.options, config);
        }
        
        return new Promise(resolve => {
            this.rl.question(`\n${question}`, answer => {
                this.currentQuestion = null;
                resolve(answer);
            });
        });
    }

    // Menu display methods
    async displayMenuWithArrows(question, options = [], config = { clear: false }, initialIndex = 0) {
        return new Promise(resolve => {
            if (config.clear) console.clear();
            
            const lines = this.normalizeOptions(options);
            let { line, col } = this.getCoordinatesFromLinearIndex(lines, initialIndex);

            const renderMenu = () => {
                if (config.clear) console.clear();
                if (question) console.log(`${question}\n`);
                
                lines.forEach((lineOpts, i) => {
                    let lineStr = lineOpts.map((opt, j) => {
                        const text = typeof opt === 'string' ? opt : opt.name || JSON.stringify(opt);
                        if (i === line && j === col) {
                            return this.highlightColor 
                                ? `${this.highlightColor}${text}${this.resetColor()}`
                                : `→ ${text}`;
                        }
                        return text;
                    }).join('   ');
                    console.log(lineStr);
                });
            };

            const handleKeyPress = async (_, key) => {
                switch (key.name) {
                    case 'up': 
                        if (line > 0) line--;
                        if (col >= lines[line].length) col = lines[line].length - 1;
                        break;
                    case 'down':
                        if (line < lines.length - 1) line++;
                        if (col >= lines[line].length) col = lines[line].length - 1;
                        break;
                    case 'left':
                        if (col > 0) col--;
                        break;
                    case 'right':
                        if (col < lines[line].length - 1) col++;
                        break;
                    case 'return':
                        stdin.removeListener('keypress', handleKeyPress);
                        stdin.setRawMode(false);
                        this.lastSelectedIndex = this.getLinearIndexFromCoordinates(lines, line, col);
                        const selected = lines[line][col];
                        if (selected?.action) await selected.action();
                        resolve(selected?.value || selected?.name || selected);
                        return;
                }
                renderMenu();
            };

            readline.emitKeypressEvents(stdin);
            stdin.setRawMode(true);
            stdin.resume();
            stdin.on('keypress', handleKeyPress);
            renderMenu();
        });
    }

    async displayMenuFromOptions(question, options, config = { clear: true }) {
        if (config.clear) console.clear();
        if (question) console.log(`${question}\n`);

        const optionMap = {};
        let index = 1;
        const printOption = (opt) => {
            const text = typeof opt === 'string' ? opt : opt.name;
            console.log(`${index}. ${text}`);
            optionMap[index++] = opt;
        };

        options.forEach(opt => {
            Array.isArray(opt) 
                ? opt.forEach(subOpt => printOption(subOpt))
                : printOption(opt);
        });

        const choice = parseInt(await this.ask('Choose an option: '));
        const selected = optionMap[choice];
        
        if (!selected) {
            console.log('Invalid option, try again.');
            return this.displayMenuFromOptions(question, options, config);
        }

        if (typeof selected === 'string') return selected;
        if (selected.action) await selected.action();
        return selected.value || selected.name;
    }

    // Utility methods
    normalizeOptions(options) {
        return options.map(opt => {
            if (Array.isArray(opt)) return opt.map(item => typeof item === 'string' ? { name: item } : item);
            if (opt?.type === 'options') return opt.value.map(item => typeof item === 'string' ? { name: item } : item);
            return [typeof opt === 'string' ? { name: opt } : opt];
        });
    }

    getCoordinatesFromLinearIndex(lines, index) {
        let count = 0;
        for (let i = 0; i < lines.length; i++) {
            if (index < count + lines[i].length) {
                return { line: i, col: index - count };
            }
            count += lines[i].length;
        }
        return { 
            line: lines.length - 1, 
            col: lines[lines.length - 1].length - 1 
        };
    }

    getLinearIndexFromCoordinates(lines, line, col) {
        return lines.slice(0, line).reduce((sum, l) => sum + l.length, 0) + col;
    }

    async displayMenu(menuGenerator, config = {}) {
        if (config.clearScreen !== false) console.clear();
        this.startLoading();
        const menu = await menuGenerator(config.props || {});
        this.stopLoading();

        if (config.alert) {
            console.log(`${config.alert_emoji || '⚠️'}  ${config.alert}\n`);
        }

        const menuTitle = await menu.title;
        const initialIndex = menuGenerator === this.lastMenuGenerator 
            ? this.lastSelectedIndex 
            : config.initialSelectedIndex || 0;
        
        this.lastMenuGenerator = menuGenerator;

        return this.numberedMenus
            ? this.displayNumberedMenu(menuTitle, menu.options)
            : this.displayMenuWithArrows(menuTitle, menu.options, config, initialIndex);
    }

    async displayNumberedMenu(title, options) {
        console.clear();
        if (title) console.log(`${title}\n`);

        const optionMap = {};
        let index = 1;
        const printOption = (opt) => {
            if (opt.type === 'options' && Array.isArray(opt.value)) {
                console.log(opt.value.map(o => `${index++}. ${o.name}`).join(' '));
                opt.value.forEach(o => optionMap[index - opt.value.length + o.value] = o);
            } 
            else if (opt.type === 'text' && opt.value) {
                console.log(opt.value);
            }
            else if (opt.name) {
                console.log(`${index}. ${opt.name}`);
                optionMap[index++] = opt;
            }
        };

        options.forEach(printOption);
        const choice = parseInt(await this.ask('\nChoose an option: '));
        const selected = optionMap[choice];

        if (!selected) {
            console.log('Invalid option, try again.');
            return this.displayNumberedMenu(title, options);
        }

        if (selected.action) await selected.action();
        return selected.value || selected.name;
    }

    pressWait() {
        return new Promise(resolve => {
            console.log('\nPress any key to continue...');
            const handler = () => {
                stdin.setRawMode(false);
                stdin.removeListener('data', handler);
                resolve();
            };
            stdin.setRawMode(true);
            stdin.once('data', handler);
        });
    }

    close() {
        this.stopAutoRefresh();
        this.rl.close();
    }
}

export default TerminalHUD;