import readline from 'readline';
import { stdin, stdout } from 'process';

/**
 * TerminalHUD - A framework for creating HUD interfaces in terminal
 * Optional mouse support: click to focus, double-click to select.
 */
class TerminalHUD {
  /**
   * Constructor
   * @param {object} config - Configuration options
   * @param {boolean} config.numberedMenus - Use numbered menus instead of arrow navigation (default: false)
   * @param {string} config.highlightColor - Color for highlighting selected menu option (default: blue)
   * @param {boolean} config.mouseSupport - Enable mouse click/double-click navigation (default: false)
   */
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

    // ✅ Optional mouse support
    this.mouseSupport = config.mouseSupport || true;
    this._mouseEventBuffer = '';
    this._mouseEnabled = false;
    this._currentMenuState = null;
    this._lastClick = { time: 0, x: -1, y: -1 };
    this._DOUBLE_CLICK_DELAY = 300;
    this._doubleClickTimeout = null;
    this._clickInProgress = false;

    // Track if we're currently in a menu
    this._inMenu = false;

    // Bind the mouse handler to maintain context
    this._handleMouseData = this._handleMouseData.bind(this);
  }

  // === Core Helper Methods ===

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

  // === Public API ===

  _resetTerminalModes() {
    // Write all terminal reset commands
    stdout.write('\x1b[?1000l'); // Disable mouse tracking
    stdout.write('\x1b[?1002l'); // Disable mouse drag tracking
    stdout.write('\x1b[?1003l'); // Disable all mouse tracking
    stdout.write('\x1b[?1006l'); // Disable SGR mouse mode
    stdout.write('\x1b[?25h');   // Show cursor
    stdout.write(''); // Force flush
  }

  _cleanupMouseSupport() {
    // Only cleanup if mouse was enabled
    if (this._mouseEnabled) {
      this._resetTerminalModes();
      stdin.removeListener('data', this._handleMouseData);
      this._mouseEnabled = false;
      this._mouseEventBuffer = '';
    }
    
    // Reset click state
    this._resetClickState();
  }

  async ask(question, config = {}) {
    if (config.options) {
      return this.numberedMenus
        ? this.displayMenuFromOptions(question, config.options, config)
        : this.displayMenuWithArrows(question, config.options, config);
    }

    // If we're in a menu, cleanup mouse support first
    if (this._inMenu) {
      this._cleanupMouseSupport();
      this._inMenu = false;
    }

    // Remove keypress listeners if any
    stdin.removeAllListeners('keypress');
    
    // Ensure raw mode is off
    if (stdin.isRaw) {
      stdin.setRawMode(false);
    }

    // Close current readline interface if it exists
    if (this.rl) {
      this.rl.close();
    }

    // Create a new clean readline interface
    return new Promise((resolve) => {
      this.rl = readline.createInterface({
        input: stdin,
        output: stdout,
        terminal: true
      });

      this.rl.question(`\n${question}`, (answer) => {
        this.rl.close();
        // Restore interface for future use
        this.rl = readline.createInterface({
          input: stdin,
          output: stdout
        });
        resolve(answer);
      });
    });
  }

  async displayMenu(menuGenerator, config = {
    props: {},
    clearScreen: true,
    alert: undefined,
    alert_emoji: '⚠️',
    initialSelectedIndex: 0,
    selectedInc: 0
  }) {
    if (config.clearScreen) console.clear();
    this.startLoading();
    const menu = await menuGenerator(config.props);
    this.stopLoading();

    if (config.alert) {
      console.log(`${config.alert_emoji || '⚠️'}  ${config.alert}\n`);
    }

    const menuTitle = await menu.title;
    let initialIndex = menuGenerator === this.lastMenuGenerator
      ? this.lastSelectedIndex
      : config.initialSelectedIndex || 0;

    if (config.selectedInc) {
      initialIndex = Math.max(0, initialIndex + config.selectedInc);
    }
   
    this.lastMenuGenerator = menuGenerator;

    return this.numberedMenus
      ? this.displayNumberedMenu(menuTitle, menu.options)
      : this.displayMenuWithArrows(menuTitle, menu.options, config, initialIndex);
  }

  async pressWait() {
    // Cleanup mouse support if active
    if (this._inMenu) {
      this._cleanupMouseSupport();
      this._inMenu = false;
    }

    // Remove any existing listeners
    stdin.removeAllListeners('keypress');
    stdin.removeAllListeners('data');
    
    // Ensure raw mode is off initially
    if (stdin.isRaw) {
      stdin.setRawMode(false);
    }

    return new Promise(resolve => {
      console.log('\nPress any key to continue...');
      
      const handler = (data) => {
        stdin.setRawMode(false);
        stdin.removeListener('data', handler);
        
        // Handle Ctrl+C
        if (data && data.toString() === '\x03') {
          process.exit(0);
        }
        
        resolve();
      };
      
      stdin.setRawMode(true);
      stdin.once('data', handler);
    });
  }

  close() {
    this._cleanupAll();
    if (this.rl) {
      this.rl.close();
    }
  }

  // === Menu Display Logic (Enhanced for Mouse) ===

  async displayMenuWithArrows(question, options = [], config = { clear: false }, initialIndex = 0) {
    if (!this.mouseSupport) {
      return this._displayMenuWithArrowsOriginal(question, options, config, initialIndex);
    }

    return new Promise((resolve) => {
      const normalized = this.normalizeOptions(options);
      if (config.clear) console.clear();

      let { line, col } = this.getCoordinatesFromLinearIndex(normalized, initialIndex);

      const renderMenu = () => {
        console.clear();
        if (question) console.log(`${question}\n`);
        normalized.forEach((lineOpts, i) => {
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

      const setFocus = (newLine, newCol) => {
        line = newLine;
        col = newCol;
        renderMenu();
      };

      const select = async () => {
        // Prevent multiple simultaneous selections
        if (this._clickInProgress) return;
        
        this._clickInProgress = true;
        
        // Get selected item before cleanup
        this.lastSelectedIndex = this.getLinearIndexFromCoordinates(normalized, line, col);
        const selected = normalized[line][col];
        
        // Clean up menu state immediately
        this._cleanupMenuState();
        
        try {
          if (selected?.action) {
            // Execute the action
            const result = selected.action();
            if (result instanceof Promise) {
              await result;
            }
          }
          
          resolve(selected?.name || selected);
        } catch (error) {
          console.error('Error in menu action:', error);
          resolve(null);
        } finally {
          this._clickInProgress = false;
        }
      };

      const handleKeyPress = async (_, key) => {
        if (!this._inMenu) return;
        
        switch (key.name) {
          case 'up':
            if (line > 0) line--;
            if (col >= normalized[line].length) col = normalized[line].length - 1;
            break;
          case 'down':
            if (line < normalized.length - 1) line++;
            if (col >= normalized[line].length) col = normalized[line].length - 1;
            break;
          case 'left':
            if (col > 0) col--;
            break;
          case 'right':
            if (col < normalized[line].length - 1) col++;
            break;
          case 'return':
            await select();
            return;
          case 'c':
            if (key.ctrl) {
              this._cleanupMenuState();
              process.exit();
            }
            break;
        }
        renderMenu();
      };

      // Setup for this menu
      this._setupMenuState(handleKeyPress);

      // Store menu state for mouse handling
      this._currentMenuState = {
        normalized,
        question,
        renderMenu,
        setFocus,
        select
      };

      renderMenu();
    });
  }

  _setupMenuState(keyPressHandler) {
    this._inMenu = true;
    
    // Remove any existing listeners
    stdin.removeAllListeners('keypress');
    
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', keyPressHandler);

    // Enable mouse tracking for this menu
    this._safeEnableMouseTracking();
  }

  _cleanupMenuState() {
    this._inMenu = false;
    
    // Remove keypress listener
    stdin.removeAllListeners('keypress');
    
    // Disable raw mode
    if (stdin.isRaw) {
      stdin.setRawMode(false);
    }
    
    // Cleanup mouse support
    this._cleanupMouseSupport();
    
    this._currentMenuState = null;
  }

  // Original implementation for fallback or non-mouse mode
  async _displayMenuWithArrowsOriginal(question, options = [], config = { clear: false }, initialIndex = 0) {
    return new Promise(resolve => {
      if (config.clear) console.clear();
     
      const normalized = this.normalizeOptions(options);
      let { line, col } = this.getCoordinatesFromLinearIndex(normalized, initialIndex);

      const renderMenu = () => {
        console.clear();
        if (question) console.log(`${question}\n`);
        normalized.forEach((lineOpts, i) => {
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
            if (col >= normalized[line].length) col = normalized[line].length - 1;
            break;
          case 'down':
            if (line < normalized.length - 1) line++;
            if (col >= normalized[line].length) col = normalized[line].length - 1;
            break;
          case 'left':
            if (col > 0) col--;
            break;
          case 'right':
            if (col < normalized[line].length - 1) col++;
            break;
          case 'return':
            stdin.removeListener('keypress', handleKeyPress);
            stdin.setRawMode(false);
            this.lastSelectedIndex = this.getLinearIndexFromCoordinates(normalized, line, col);
            const selected = normalized[line][col];
            if (selected?.action) await selected.action();
            resolve(selected?.name || selected);
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
    if (!this.numberedMenus) {
      return this.displayMenuWithArrows(question, options, config);
    }

    console.clear();
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
    return selected.name;
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
    return selected.name;
  }

  // === Menu Utilities ===

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

  // === Mouse Support ===

  _safeEnableMouseTracking() {
    if (this._mouseEnabled || !this._inMenu) return;
    
    try {
      // Enable mouse tracking
      stdout.write('\x1b[?1000h'); // Enable X10 mouse mode
      stdout.write('\x1b[?1006h'); // Enable SGR mouse mode for better compatibility
      this._mouseEnabled = true;

      // Add the mouse event listener
      stdin.on('data', this._handleMouseData);
    } catch (error) {
      this._mouseEnabled = false;
    }
  }

  _cleanupAll() {
    this._inMenu = false;
    this._cleanupMouseSupport();
    
    if (this._doubleClickTimeout) {
      clearTimeout(this._doubleClickTimeout);
      this._doubleClickTimeout = null;
    }
  }

  _resetClickState() {
    this._lastClick = { time: 0, x: -1, y: -1 };
    this._clickInProgress = false;
    
    if (this._doubleClickTimeout) {
      clearTimeout(this._doubleClickTimeout);
      this._doubleClickTimeout = null;
    }
  }

  _handleMouseData(data) {
    if (!this.mouseSupport || !this._inMenu || !this._currentMenuState) {
      return;
    }

    const str = data.toString();
    
    // Check if this is a mouse event
    if (!str.includes('\x1b[') || (!str.includes('M') && !str.includes('m'))) {
      return;
    }

    this._mouseEventBuffer += str;

    // Process SGR mouse events
    const sgrMatch = this._mouseEventBuffer.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (sgrMatch) {
      this._mouseEventBuffer = '';
      this._handleSGRMouseEvent(sgrMatch);
      return;
    }

    // Process X10 mouse events
    const x10Match = this._mouseEventBuffer.match(/\x1b\[M([\x00-\xFF]{3})/);
    if (x10Match) {
      this._mouseEventBuffer = '';
      this._handleX10MouseEvent(x10Match);
      return;
    }

    if (this._mouseEventBuffer.length > 20) {
      this._mouseEventBuffer = '';
    }
  }

  _handleSGRMouseEvent(match) {
    const button = parseInt(match[1]);
    const x = parseInt(match[2]) - 1;
    const y = parseInt(match[3]) - 1;
    const eventType = match[4];

    if (eventType === 'M' && button === 0) {
      this._processMouseClick(x, y);
    }
  }

  _handleX10MouseEvent(match) {
    const bytes = match[1];
    const button = bytes.charCodeAt(0) - 32;
    const x = bytes.charCodeAt(1) - 33;
    const y = bytes.charCodeAt(2) - 33;

    if (button === 0) {
      this._processMouseClick(x, y);
    }
  }

  _processMouseClick(x, y) {
    if (this._clickInProgress) return;

    const { normalized, question, setFocus, select } = this._currentMenuState;
    const clickedIndex = this._findOptionIndexAt(y, x, normalized, question);

    if (clickedIndex === -1) return;

    const { line: targetLine, col: targetCol } = this.getCoordinatesFromLinearIndex(normalized, clickedIndex);

    setFocus(targetLine, targetCol);

    const now = Date.now();
    const isDoubleClick = (now - this._lastClick.time < this._DOUBLE_CLICK_DELAY &&
                          this._lastClick.x === x && 
                          this._lastClick.y === y);

    if (isDoubleClick) {
      this._lastClick = { time: 0, x: -1, y: -1 };
      if (this._doubleClickTimeout) {
        clearTimeout(this._doubleClickTimeout);
        this._doubleClickTimeout = null;
      }
      
      select().catch(error => {
        console.error('Error in menu selection:', error);
      });
    } else {
      this._lastClick = { time: now, x, y };
      
      if (this._doubleClickTimeout) {
        clearTimeout(this._doubleClickTimeout);
      }
      
      this._doubleClickTimeout = setTimeout(() => {
        this._lastClick = { time: 0, x: -1, y: -1 };
        this._doubleClickTimeout = null;
      }, this._DOUBLE_CLICK_DELAY);
    }
  }

  _findOptionIndexAt(terminalY, terminalX, normalized, question) {
    let startRow = 0;
    if (question) {
      const questionLines = question.split('\n').length;
      startRow += questionLines + 1;
    }

    for (let row = 0; row < normalized.length; row++) {
      const actualRow = startRow + row;
      
      if (actualRow === terminalY) {
        let currentCol = 0;
        for (let col = 0; col < normalized[row].length; col++) {
          const opt = normalized[row][col];
          const text = typeof opt === 'string' ? opt : opt.name || JSON.stringify(opt);
          const textWidth = text.length;

          const optionStart = currentCol;
          const optionEnd = currentCol + textWidth;
          
          if (terminalX >= optionStart && terminalX <= optionEnd + 2) {
            return this.getLinearIndexFromCoordinates(normalized, row, col);
          }

          currentCol += textWidth + 3;
        }
        break;
      }
    }

    return -1;
  }
}

export default TerminalHUD;