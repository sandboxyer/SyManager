import readline from 'readline';
import { stdin, stdout } from 'process';
import EventEmitter from 'events';

/**
 * TerminalHUD - A framework for creating HUD interfaces in terminal
 * Optional mouse support: click to focus, double-click to select, wheel to navigate.
 * Now extends EventEmitter for event-driven architecture.
 */
class TerminalHUD extends EventEmitter {
  /**
   * Constructor
   * @param {object} configuration - Configuration options
   * @param {boolean} configuration.numberedMenus - Use numbered menus instead of arrow navigation (default: false)
   * @param {string} configuration.highlightColor - Color for highlighting selected menu option (default: blue)
   * @param {boolean} configuration.mouseSupport - Enable mouse click/double-click navigation (default: false)
   * @param {boolean} configuration.mouseWheel - Enable mouse wheel navigation (default: true when mouseSupport is true)
   * @param {boolean} configuration.enableEvents - Enable event emission (default: true)
   */
  constructor(configuration = {}) {
    super(); // Initialize EventEmitter
    
    this.readlineInterface = readline.createInterface({
      input: stdin,
      output: stdout
    });
    this.isLoading = false;
    this.numberedMenus = configuration.numberedMenus || false;
    this.highlightColor = this.getAnsiBackgroundColor(configuration.highlightColor || 'blue');
    this.lastMenuGenerator = null;
    this.lastSelectedIndex = 0;
    
    // Event emission configuration
    this.enableEvents = configuration.enableEvents !== false; // Default to true

    // Optional mouse support
    this.mouseSupport = configuration.mouseSupport || true;
    this.mouseWheel = configuration.mouseWheel !== undefined ? configuration.mouseWheel : this.mouseSupport;
    this.mouseEventBuffer = '';
    this.isMouseEnabled = false;
    this.currentMenuState = null;
    this.lastMouseClick = { time: 0, x: -1, y: -1 };
    this.DOUBLE_CLICK_DELAY = 300;
    this.doubleClickTimeout = null;
    this.isClickInProgress = false;
    
    // Mouse wheel state
    this.wheelAccumulator = 0;
    this.WHEEL_THRESHOLD = 1; // Number of wheel events needed to trigger navigation

    // Track if we're currently in a menu
    this.isInMenu = false;

    // Track if selection is from keyboard
    this.isKeyboardSelection = false;

    // Bind the mouse handler to maintain context
    this.handleMouseData = this.handleMouseData.bind(this);
    
    // Event types documentation
    this.eventTypes = {
      // Menu events
      MENU_DISPLAY: 'menu:display',
      MENU_SELECTION: 'menu:selection',
      MENU_NAVIGATION: 'menu:navigation',
      MENU_CLOSE: 'menu:close',
      
      // Input events
      QUESTION_ASK: 'question:ask',
      QUESTION_ANSWER: 'question:answer',
      
      // Loading events
      LOADING_START: 'loading:start',
      LOADING_STOP: 'loading:stop',
      
      // Mouse events
      MOUSE_CLICK: 'mouse:click',
      MOUSE_DOUBLE_CLICK: 'mouse:doubleclick',
      MOUSE_WHEEL: 'mouse:wheel',
      
      // Key events
      KEY_PRESS: 'key:press',
      
      // General events
      PRESS_WAIT: 'press:wait'
    };
  }

  // Event Emission Helper
  emitEvent(eventName, eventData = {}) {
    if (this.enableEvents && this.listenerCount(eventName) > 0) {
      this.emit(eventName, {
        timestamp: Date.now(),
        ...eventData
      });
    }
    // Also emit wildcard event for all listeners
    if (this.enableEvents && this.listenerCount('*') > 0) {
      this.emit('*', {
        event: eventName,
        timestamp: Date.now(),
        ...eventData
      });
    }
  }

  // Core Helper Methods

  getAnsiBackgroundColor(color) {
    const colors = {
      red: '\x1b[41m',
      green: '\x1b[42m',
      yellow: '\x1b[43m',
      blue: '\x1b[44m',
      magenta: '\x1b[45m',
      cyan: '\x1b[46m',
      white: '\x1b[47m'
    };
    return colors[color] || '';
  }

  resetColor() {
    return '\x1b[0m';
  }

  startLoading() {
    this.isLoading = true;
    
    // Emit loading start event
    this.emitEvent(this.eventTypes.LOADING_START);
    
    let loadingCounter = 0;
    this.loadingInterval = setInterval(() => {
      stdout.clearLine();
      stdout.cursorTo(0);
      stdout.write(`⏳ Loading${'.'.repeat(loadingCounter)}`);
      loadingCounter = (loadingCounter + 1) % 4;
    }, 500);
  }

  stopLoading() {
    this.isLoading = false;
    clearInterval(this.loadingInterval);
    stdout.clearLine();
    stdout.cursorTo(0);
    
    // Emit loading stop event
    this.emitEvent(this.eventTypes.LOADING_STOP);
  }

  // Public API

  resetTerminalModes() {
    // Write all terminal reset commands
    stdout.write('\x1b[?1000l'); // Disable mouse tracking
    stdout.write('\x1b[?1002l'); // Disable mouse drag tracking
    stdout.write('\x1b[?1003l'); // Disable all mouse tracking
    stdout.write('\x1b[?1006l'); // Disable SGR mouse mode
    stdout.write('\x1b[?25h');   // Show cursor
    stdout.write(''); // Force flush
  }

  cleanupMouseSupport() {
    // Only cleanup if mouse was enabled
    if (this.isMouseEnabled) {
      this.resetTerminalModes();
      stdin.removeListener('data', this.handleMouseData);
      this.isMouseEnabled = false;
      this.mouseEventBuffer = '';
    }
    
    // Reset click state
    this.resetClickState();
    
    // Reset wheel accumulator
    this.wheelAccumulator = 0;
  }

  async ask(question, configuration = {}) {
    // Emit question ask event
    this.emitEvent(this.eventTypes.QUESTION_ASK, {
      question,
      configuration
    });

    if (configuration.options) {
      return this.numberedMenus
        ? this.displayMenuFromOptions(question, configuration.options, configuration)
        : this.displayMenuWithArrows(question, configuration.options, configuration);
    }

    // If we're in a menu, cleanup mouse support first
    if (this.isInMenu) {
      this.cleanupMouseSupport();
      this.isInMenu = false;
    }

    // Remove keypress listeners if any
    stdin.removeAllListeners('keypress');
    
    // Ensure raw mode is off
    if (stdin.isRaw) {
      stdin.setRawMode(false);
    }

    // Close current readline interface if it exists
    if (this.readlineInterface) {
      this.readlineInterface.close();
    }

    // Create a new clean readline interface
    return new Promise((resolve) => {
      this.readlineInterface = readline.createInterface({
        input: stdin,
        output: stdout,
        terminal: true
      });

      this.readlineInterface.question(`\n${question}`, (answer) => {
        this.readlineInterface.close();
        
        // Emit question answer event
        this.emitEvent(this.eventTypes.QUESTION_ANSWER, {
          question,
          answer,
          configuration
        });
        
        // Restore interface for future use
        this.readlineInterface = readline.createInterface({
          input: stdin,
          output: stdout
        });
        resolve(answer);
      });
    });
  }

  async displayMenu(menuGenerator, configuration = {
    props: {},
    clearScreen: true,
    alert: undefined,
    alertEmoji: '⚠️',
    initialSelectedIndex: 0,
    selectedIncrement: 0
  }) {
    if (configuration.clearScreen) console.clear();
    this.startLoading();
    const menu = await menuGenerator(configuration.props);
    this.stopLoading();

    if (configuration.alert) {
      console.log(`${configuration.alertEmoji || '⚠️'}  ${configuration.alert}\n`);
    }

    const menuTitle = await menu.title;
    let initialIndex = menuGenerator === this.lastMenuGenerator
      ? this.lastSelectedIndex
      : configuration.initialSelectedIndex || 0;

    if (configuration.selectedIncrement) {
      initialIndex = Math.max(0, initialIndex + configuration.selectedIncrement);
    }
   
    this.lastMenuGenerator = menuGenerator;

    return this.numberedMenus
      ? this.displayNumberedMenu(menuTitle, menu.options)
      : this.displayMenuWithArrows(menuTitle, menu.options, configuration, initialIndex);
  }

  async pressWait() {
    // Emit press wait event
    this.emitEvent(this.eventTypes.PRESS_WAIT);

    // Cleanup mouse support if active
    if (this.isInMenu) {
      this.cleanupMouseSupport();
      this.isInMenu = false;
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
      
      const keyHandler = (data) => {
        stdin.setRawMode(false);
        stdin.removeListener('data', keyHandler);
        
        // Emit key press event
        this.emitEvent(this.eventTypes.KEY_PRESS, {
          key: data.toString(),
          isCtrlC: data.toString() === '\x03'
        });
        
        // Handle Ctrl+C
        if (data && data.toString() === '\x03') {
          process.exit(0);
        }
        
        resolve();
      };
      
      stdin.setRawMode(true);
      stdin.once('data', keyHandler);
    });
  }

  close() {
    // Emit menu close event if in menu
    if (this.isInMenu) {
      this.emitEvent(this.eventTypes.MENU_CLOSE);
    }
    
    this.cleanupAll();
    if (this.readlineInterface) {
      this.readlineInterface.close();
    }
  }

  // Menu Display Logic (Enhanced for Mouse)

  async displayMenuWithArrows(question, options = [], configuration = { clear: false }, initialIndex = 0) {
    // Emit menu display event
    this.emitEvent(this.eventTypes.MENU_DISPLAY, {
      question,
      options: this.sanitizeOptionsForEvent(options),
      configuration,
      initialIndex,
      menuType: 'arrow'
    });

    if (!this.mouseSupport) {
      return this.displayMenuWithArrowsOriginal(question, options, configuration, initialIndex);
    }

    return new Promise((resolve) => {
      const normalizedOptions = this.normalizeOptions(options);
      if (configuration.clear) console.clear();

      let { line, column } = this.getCoordinatesFromLinearIndex(normalizedOptions, initialIndex);

      const renderMenu = () => {
        console.clear();
        if (question) console.log(`${question}\n`);
        normalizedOptions.forEach((lineOptions, lineIndex) => {
          let lineString = lineOptions.map((option, columnIndex) => {
            const text = typeof option === 'string' ? option : option.name || JSON.stringify(option);
            if (lineIndex === line && columnIndex === column) {
              return this.highlightColor
                ? `${this.highlightColor}${text}${this.resetColor()}`
                : `→ ${text}`;
            }
            return text;
          }).join('   ');
          console.log(lineString);
        });
      };

      const setFocus = (newLine, newColumn) => {
        line = newLine;
        column = newColumn;
        
        // Emit menu navigation event
        this.emitEvent(this.eventTypes.MENU_NAVIGATION, {
          line: newLine,
          column: newColumn,
          linearIndex: this.getLinearIndexFromCoordinates(normalizedOptions, newLine, newColumn),
          question
        });
        
        renderMenu();
      };

      const selectOption = async (selectionSource = 'mouse') => {
        // Prevent multiple simultaneous selections
        if (this.isClickInProgress) return;
        
        this.isClickInProgress = true;
        
        // Get selected item before cleanup
        this.lastSelectedIndex = this.getLinearIndexFromCoordinates(normalizedOptions, line, column);
        const selected = normalizedOptions[line][column];
        
        // Emit menu selection event with data
        const selectionEventData = {
          index: this.lastSelectedIndex,
          line,
          column,
          selected: this.getOptionDataForEvent(selected),
          question,
          source: selectionSource
        };
        
        // Add custom data from option if available
        if (selected && typeof selected === 'object') {
          if (selected.eventData) {
            selectionEventData.customData = selected.eventData;
          }
          if (selected.metadata) {
            selectionEventData.metadata = selected.metadata;
          }
        }
        
        this.emitEvent(this.eventTypes.MENU_SELECTION, selectionEventData);
        
        // Clean up menu state immediately
        this.cleanupMenuState();
        
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
          this.isClickInProgress = false;
        }
      };

      const handleKeyPress = async (_, key) => {
        if (!this.isInMenu) return;
        
        // Emit key press event for menu
        this.emitEvent(this.eventTypes.KEY_PRESS, {
          key: key.name,
          sequence: key.sequence,
          ctrl: key.ctrl,
          shift: key.shift,
          meta: key.meta,
          inMenu: true
        });
        
        switch (key.name) {
          case 'up':
            if (line > 0) line--;
            if (column >= normalizedOptions[line].length) column = normalizedOptions[line].length - 1;
            setFocus(line, column);
            break;
          case 'down':
            if (line < normalizedOptions.length - 1) line++;
            if (column >= normalizedOptions[line].length) column = normalizedOptions[line].length - 1;
            setFocus(line, column);
            break;
          case 'left':
            if (column > 0) column--;
            setFocus(line, column);
            break;
          case 'right':
            if (column < normalizedOptions[line].length - 1) column++;
            setFocus(line, column);
            break;
          case 'return':
            await selectOption('keyboard');
            return;
          case 'c':
            if (key.ctrl) {
              this.cleanupMenuState();
              process.exit();
            }
            break;
        }
      };

      // Setup for this menu
      this.setupMenuState(handleKeyPress);

      // Store menu state for mouse handling
      this.currentMenuState = {
        normalizedOptions,
        question,
        renderMenu,
        setFocus,
        selectOption,
        currentLine: line,
        currentColumn: column
      };

      renderMenu();
    });
  }

  setupMenuState(keyPressHandler) {
    this.isInMenu = true;
    
    // Remove any existing listeners
    stdin.removeAllListeners('keypress');
    
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', keyPressHandler);

    // Enable mouse tracking for this menu
    this.safeEnableMouseTracking();
  }

  cleanupMenuState() {
    this.isInMenu = false;
    
    // Remove keypress listener
    stdin.removeAllListeners('keypress');
    
    // Disable raw mode
    if (stdin.isRaw) {
      stdin.setRawMode(false);
    }
    
    // Cleanup mouse support
    this.cleanupMouseSupport();
    
    this.currentMenuState = null;
    this.wheelAccumulator = 0;
  }

  // Original implementation for fallback or non-mouse mode
  async displayMenuWithArrowsOriginal(question, options = [], configuration = { clear: false }, initialIndex = 0) {
    // Emit menu display event
    this.emitEvent(this.eventTypes.MENU_DISPLAY, {
      question,
      options: this.sanitizeOptionsForEvent(options),
      configuration,
      initialIndex,
      menuType: 'arrow-original'
    });

    return new Promise(resolve => {
      if (configuration.clear) console.clear();
     
      const normalizedOptions = this.normalizeOptions(options);
      let { line, column } = this.getCoordinatesFromLinearIndex(normalizedOptions, initialIndex);

      const renderMenu = () => {
        console.clear();
        if (question) console.log(`${question}\n`);
        normalizedOptions.forEach((lineOptions, lineIndex) => {
          let lineString = lineOptions.map((option, columnIndex) => {
            const text = typeof option === 'string' ? option : option.name || JSON.stringify(option);
            if (lineIndex === line && columnIndex === column) {
              return this.highlightColor
                ? `${this.highlightColor}${text}${this.resetColor()}`
                : `→ ${text}`;
            }
            return text;
          }).join('   ');
          console.log(lineString);
        });
      };

      const handleKeyPress = async (_, key) => {
        // Emit key press event for menu
        this.emitEvent(this.eventTypes.KEY_PRESS, {
          key: key.name,
          sequence: key.sequence,
          ctrl: key.ctrl,
          shift: key.shift,
          meta: key.meta,
          inMenu: true
        });
        
        switch (key.name) {
          case 'up':
            if (line > 0) line--;
            if (column >= normalizedOptions[line].length) column = normalizedOptions[line].length - 1;
            break;
          case 'down':
            if (line < normalizedOptions.length - 1) line++;
            if (column >= normalizedOptions[line].length) column = normalizedOptions[line].length - 1;
            break;
          case 'left':
            if (column > 0) column--;
            break;
          case 'right':
            if (column < normalizedOptions[line].length - 1) column++;
            break;
          case 'return':
            stdin.removeListener('keypress', handleKeyPress);
            stdin.setRawMode(false);
            this.lastSelectedIndex = this.getLinearIndexFromCoordinates(normalizedOptions, line, column);
            const selected = normalizedOptions[line][column];
            
            // Emit menu selection event
            const selectionEventData = {
              index: this.lastSelectedIndex,
              line,
              column,
              selected: this.getOptionDataForEvent(selected),
              question,
              source: 'keyboard'
            };
            
            // Add custom data from option if available
            if (selected && typeof selected === 'object') {
              if (selected.eventData) {
                selectionEventData.customData = selected.eventData;
              }
              if (selected.metadata) {
                selectionEventData.metadata = selected.metadata;
              }
            }
            
            this.emitEvent(this.eventTypes.MENU_SELECTION, selectionEventData);
            
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

  async displayMenuFromOptions(question, options, configuration = { clear: true }) {
    if (!this.numberedMenus) {
      return this.displayMenuWithArrows(question, options, configuration);
    }

    // Emit menu display event
    this.emitEvent(this.eventTypes.MENU_DISPLAY, {
      question,
      options: this.sanitizeOptionsForEvent(options),
      configuration,
      menuType: 'numbered-from-options'
    });

    console.clear();
    if (question) console.log(`${question}\n`);

    const optionMap = {};
    let index = 1;
    const printOption = (option) => {
      const text = typeof option === 'string' ? option : option.name;
      console.log(`${index}. ${text}`);
      optionMap[index++] = option;
    };

    options.forEach(option => {
      Array.isArray(option)
        ? option.forEach(subOption => printOption(subOption))
        : printOption(option);
    });

    const choice = parseInt(await this.ask('Choose an option: '));
    const selected = optionMap[choice];
   
    if (!selected) {
      console.log('Invalid option, try again.');
      return this.displayMenuFromOptions(question, options, configuration);
    }

    if (typeof selected === 'string') return selected;
    
    // Emit menu selection event
    this.emitEvent(this.eventTypes.MENU_SELECTION, {
      index: choice,
      selected: this.getOptionDataForEvent(selected),
      question,
      source: 'numbered'
    });
    
    if (selected.action) await selected.action();
    return selected.name;
  }

  async displayNumberedMenu(title, options) {
    // Emit menu display event
    this.emitEvent(this.eventTypes.MENU_DISPLAY, {
      question: title,
      options: this.sanitizeOptionsForEvent(options),
      menuType: 'numbered'
    });

    console.clear();
    if (title) console.log(`${title}\n`);

    const optionMap = {};
    let index = 1;
    const printOption = (option) => {
      if (option.type === 'options' && Array.isArray(option.value)) {
        console.log(option.value.map(individualOption => `${index++}. ${individualOption.name}`).join(' '));
        option.value.forEach(individualOption => optionMap[index - option.value.length + individualOption.value] = individualOption);
      }
      else if (option.type === 'text' && option.value) {
        console.log(option.value);
      }
      else if (option.name) {
        console.log(`${index}. ${option.name}`);
        optionMap[index++] = option;
      }
    };

    options.forEach(printOption);
    const choice = parseInt(await this.ask('\nChoose an option: '));
    const selected = optionMap[choice];

    if (!selected) {
      console.log('Invalid option, try again.');
      return this.displayNumberedMenu(title, options);
    }

    // Emit menu selection event
    this.emitEvent(this.eventTypes.MENU_SELECTION, {
      index: choice,
      selected: this.getOptionDataForEvent(selected),
      question: title,
      source: 'numbered'
    });
    
    if (selected.action) await selected.action();
    return selected.name;
  }

  // Menu Utilities

  normalizeOptions(options) {
    return options.map(option => {
      if (Array.isArray(option)) return option.map(item => typeof item === 'string' ? { name: item } : item);
      if (option?.type === 'options') return option.value.map(item => typeof item === 'string' ? { name: item } : item);
      return [typeof option === 'string' ? { name: option } : option];
    });
  }

  getCoordinatesFromLinearIndex(lines, index) {
    let count = 0;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      if (index < count + lines[lineIndex].length) {
        return { line: lineIndex, column: index - count };
      }
      count += lines[lineIndex].length;
    }
    return {
      line: lines.length - 1,
      column: lines[lines.length - 1].length - 1
    };
  }

  getLinearIndexFromCoordinates(lines, line, column) {
    return lines.slice(0, line).reduce((sum, currentLine) => sum + currentLine.length, 0) + column;
  }

  // Helper methods for event data
  
  sanitizeOptionsForEvent(options) {
    return options.map(option => {
      if (typeof option === 'string') {
        return { name: option };
      }
      if (Array.isArray(option)) {
        return option.map(item => this.getOptionDataForEvent(item));
      }
      return this.getOptionDataForEvent(option);
    });
  }
  
  getOptionDataForEvent(option) {
    if (!option) return null;
    
    if (typeof option === 'string') {
      return { name: option };
    }
    
    // Return a safe object without functions for event emission
    const eventData = {
      name: option.name,
      type: option.type,
      value: option.value
    };
    
    // Include custom data if present
    if (option.eventData) {
      eventData.eventData = option.eventData;
    }
    if (option.metadata) {
      eventData.metadata = option.metadata;
    }
    
    return eventData;
  }

  // Mouse Support (Enhanced with Wheel)

  safeEnableMouseTracking() {
    if (this.isMouseEnabled || !this.isInMenu) return;
    
    try {
      // Enable mouse tracking with wheel support
      stdout.write('\x1b[?1000h'); // Enable basic mouse tracking
      stdout.write('\x1b[?1002h'); // Enable cell motion tracking
      stdout.write('\x1b[?1003h'); // Enable all motion tracking (includes wheel)
      stdout.write('\x1b[?1006h'); // Enable SGR mouse mode
      this.isMouseEnabled = true;

      // Add the mouse event listener
      stdin.on('data', this.handleMouseData);
    } catch (error) {
      this.isMouseEnabled = false;
    }
  }

  cleanupAll() {
    this.isInMenu = false;
    this.cleanupMouseSupport();
    
    if (this.doubleClickTimeout) {
      clearTimeout(this.doubleClickTimeout);
      this.doubleClickTimeout = null;
    }
  }

  resetClickState() {
    this.lastMouseClick = { time: 0, x: -1, y: -1 };
    this.isClickInProgress = false;
    
    if (this.doubleClickTimeout) {
      clearTimeout(this.doubleClickTimeout);
      this.doubleClickTimeout = null;
    }
  }

  handleMouseData(data) {
    if (!this.mouseSupport || !this.isInMenu || !this.currentMenuState) {
      return;
    }

    const stringData = data.toString();
    
    // Check if this is a mouse event
    if (!stringData.includes('\x1b[') || (!stringData.includes('M') && !stringData.includes('m'))) {
      return;
    }

    this.mouseEventBuffer += stringData;

    // Process SGR mouse events (modern terminal mouse protocol)
    const sgrMatch = this.mouseEventBuffer.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (sgrMatch) {
      this.mouseEventBuffer = '';
      this.handleSGRMouseEvent(sgrMatch);
      return;
    }

    // Process X10 mouse events (legacy terminal mouse protocol)
    const x10Match = this.mouseEventBuffer.match(/\x1b\[M([\x00-\xFF]{3})/);
    if (x10Match) {
      this.mouseEventBuffer = '';
      this.handleX10MouseEvent(x10Match);
      return;
    }

    // Clear buffer if it gets too long (malformed data)
    if (this.mouseEventBuffer.length > 20) {
      this.mouseEventBuffer = '';
    }
  }

  handleSGRMouseEvent(match) {
    const button = parseInt(match[1]);
    const x = parseInt(match[2]) - 1;
    const y = parseInt(match[3]) - 1;
    const eventType = match[4];

    // Check for mouse wheel events first (button codes 64 and 65 for wheel up/down in SGR mode)
    if (button & 64) {
      // Wheel event in SGR mode
      const isWheelDown = (button & 1) === 1;
      
      // Emit mouse wheel event
      this.emitEvent(this.eventTypes.MOUSE_WHEEL, {
        x,
        y,
        direction: isWheelDown ? 'down' : 'up',
        buttonCode: button
      });
      
      this.processMouseWheel(x, y, isWheelDown ? 'down' : 'up');
    }
    // Check for left click (button code 0 with eventType 'M')
    else if (eventType === 'M' && button === 0) {
      // Emit mouse click event
      this.emitEvent(this.eventTypes.MOUSE_CLICK, {
        x,
        y,
        button: 'left',
        buttonCode: button
      });
      
      this.processMouseClick(x, y);
    }
  }

  handleX10MouseEvent(match) {
    const bytes = match[1];
    const button = bytes.charCodeAt(0) - 32;
    const x = bytes.charCodeAt(1) - 33;
    const y = bytes.charCodeAt(2) - 33;

    // Check for mouse wheel events in X10 mode (button codes 96 and 97 for wheel up/down)
    if (button >= 96 && button <= 97) {
      const isWheelDown = button === 97;
      
      // Emit mouse wheel event
      this.emitEvent(this.eventTypes.MOUSE_WHEEL, {
        x,
        y,
        direction: isWheelDown ? 'down' : 'up',
        buttonCode: button
      });
      
      this.processMouseWheel(x, y, isWheelDown ? 'down' : 'up');
    }
    // Check for left click (button code 0)
    else if (button === 0) {
      // Emit mouse click event
      this.emitEvent(this.eventTypes.MOUSE_CLICK, {
        x,
        y,
        button: 'left',
        buttonCode: button
      });
      
      this.processMouseClick(x, y);
    }
  }

  processMouseClick(x, y) {
    if (this.isClickInProgress) return;

    const { normalizedOptions, question, setFocus, selectOption } = this.currentMenuState;
    const clickedIndex = this.findOptionIndexAtCoordinates(y, x, normalizedOptions, question);

    if (clickedIndex === -1) return;

    const { line: targetLine, column: targetColumn } = this.getCoordinatesFromLinearIndex(normalizedOptions, clickedIndex);

    setFocus(targetLine, targetColumn);

    const currentTime = Date.now();
    const isDoubleClick = (currentTime - this.lastMouseClick.time < this.DOUBLE_CLICK_DELAY &&
                          this.lastMouseClick.x === x && 
                          this.lastMouseClick.y === y);

    if (isDoubleClick) {
      // Emit mouse double click event
      this.emitEvent(this.eventTypes.MOUSE_DOUBLE_CLICK, {
        x,
        y,
        button: 'left'
      });
      
      this.lastMouseClick = { time: 0, x: -1, y: -1 };
      if (this.doubleClickTimeout) {
        clearTimeout(this.doubleClickTimeout);
        this.doubleClickTimeout = null;
      }
      
      selectOption('mouse').catch(error => {
        console.error('Error in menu selection:', error);
      });
    } else {
      this.lastMouseClick = { time: currentTime, x, y };
      
      if (this.doubleClickTimeout) {
        clearTimeout(this.doubleClickTimeout);
      }
      
      this.doubleClickTimeout = setTimeout(() => {
        this.lastMouseClick = { time: 0, x: -1, y: -1 };
        this.doubleClickTimeout = null;
      }, this.DOUBLE_CLICK_DELAY);
    }
  }

  processMouseWheel(x, y, direction) {
    if (!this.currentMenuState || !this.mouseWheel || this.isClickInProgress) {
      return;
    }

    const { normalizedOptions, setFocus, currentLine, currentColumn } = this.currentMenuState;
    
    // Accumulate wheel events to smooth out navigation
    this.wheelAccumulator += (direction === 'down' ? 1 : -1);
    
    // Only navigate when threshold is reached
    if (Math.abs(this.wheelAccumulator) >= this.WHEEL_THRESHOLD) {
      let newLine = currentLine;
      let newColumn = currentColumn;
      
      if (direction === 'down') {
        // Move down (next item)
        const linearIndex = this.getLinearIndexFromCoordinates(normalizedOptions, currentLine, currentColumn);
        const totalItems = normalizedOptions.reduce((sum, line) => sum + line.length, 0);
        
        if (linearIndex < totalItems - 1) {
          const newLinearIndex = linearIndex + 1;
          const coordinates = this.getCoordinatesFromLinearIndex(normalizedOptions, newLinearIndex);
          newLine = coordinates.line;
          newColumn = coordinates.column;
        }
      } else {
        // Move up (previous item)
        const linearIndex = this.getLinearIndexFromCoordinates(normalizedOptions, currentLine, currentColumn);
        
        if (linearIndex > 0) {
          const newLinearIndex = linearIndex - 1;
          const coordinates = this.getCoordinatesFromLinearIndex(normalizedOptions, newLinearIndex);
          newLine = coordinates.line;
          newColumn = coordinates.column;
        }
      }
      
      // Update the menu state with new position
      this.currentMenuState.currentLine = newLine;
      this.currentMenuState.currentColumn = newColumn;
      
      // Set focus to new position
      setFocus(newLine, newColumn);
      
      // Reset accumulator
      this.wheelAccumulator = 0;
    }
  }

  findOptionIndexAtCoordinates(terminalY, terminalX, normalizedOptions, question) {
    let startRow = 0;
    if (question) {
      const questionLines = question.split('\n').length;
      startRow += questionLines + 1;
    }

    for (let row = 0; row < normalizedOptions.length; row++) {
      const actualRow = startRow + row;
      
      if (actualRow === terminalY) {
        let currentColumn = 0;
        for (let column = 0; column < normalizedOptions[row].length; column++) {
          const option = normalizedOptions[row][column];
          const text = typeof option === 'string' ? option : option.name || JSON.stringify(option);
          const textWidth = text.length;

          const optionStart = currentColumn;
          const optionEnd = currentColumn + textWidth;
          
          if (terminalX >= optionStart && terminalX <= optionEnd + 2) {
            return this.getLinearIndexFromCoordinates(normalizedOptions, row, column);
          }

          currentColumn += textWidth + 3;
        }
        break;
      }
    }

    return -1;
  }
}


//--------------------------- SyAPP Structure start below ----------------------------------

class SyAPP_Func {
    constructor(name,build = async (props) => {},config = {log : false,linked : []}){
        this.Name = name
        this.Linked = config.linked || []
        this.Log = config.log || false

        class userBuild {
            constructor(id,data = {}){
              this.ID = id
              this.Buttons = []
            }

        }

      this.Builds = [new userBuild(0)]  

      this.Button = (id,text,path,config = {props : {}}) => {
        if(this.Builds[this.Builds.findIndex(e => e.ID == id)]){
            this.Builds[this.Builds.findIndex(e => e.ID == id)].Buttons.push()
        } else {
            if(this.Log){console.log(`Button Load Error | Text : ${text} | BuildID : ${id} | Path : ${path}`)}
        }

      }

      }
}



class SyAPP {
    constructor(Func = SyAPP_Func,config = {}){



    }
}

export default SyAPP