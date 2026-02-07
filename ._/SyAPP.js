import readline from 'readline';
import { stdin, stdout } from 'process';
import EventEmitter from 'events';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { createHash } from 'crypto';

function getMachineID() {
    // Try primary DMI method
    try {
        if (existsSync('/sys/class/dmi/id/product_uuid')) {
            const uuid = readFileSync('/sys/class/dmi/id/product_uuid', 'utf8').trim();
            if (uuid && uuid.length >= 36) {
                return uuid.toUpperCase();
            }
        }
    } catch {}

    // Fallback 1: /etc/machine-id (Linux)
    try {
        if (existsSync('/etc/machine-id')) {
            const id = readFileSync('/etc/machine-id', 'utf8').trim();
            if (id.length >= 32) return `MACHINE-ID-${id}`;
        }
    } catch {}

    // Fallback 2: CPU info serial (Linux ARM)
    try {
        const cpuinfo = readFileSync('/proc/cpuinfo', 'utf8');
        const lines = cpuinfo.split('\n');
        for (const line of lines) {
            if (line.includes('Serial') && line.includes(':')) {
                const serial = line.split(':')[1].trim();
                if (serial.length > 0) return `CPU-${serial}`;
            }
        }
    } catch {}

    // Fallback 3: MAC address (first network interface)
    try {
        const netPath = '/sys/class/net/';
        const interfaces = execSync(`ls ${netPath}`, { stdio: ['pipe', 'pipe', 'ignore'] })
            .toString()
            .split('\n')
            .filter(iface => iface && !iface.startsWith('lo'));
        
        if (interfaces.length > 0) {
            const mac = readFileSync(`${netPath}${interfaces[0]}/address`, 'utf8').trim();
            if (mac) return `MAC-${mac.replace(/:/g, '').toUpperCase()}`;
        }
    } catch {}

    // Fallback 4: Disk UUID (first disk)
    try {
        const disks = execSync('lsblk -o UUID,MOUNTPOINT -n 2>/dev/null || true', { shell: true })
            .toString()
            .split('\n')
            .filter(line => line && !line.includes('MOUNTPOINT'));
        
        if (disks.length > 0) {
            const diskUuid = disks[0].split(' ')[0].trim();
            if (diskUuid) return `DISK-${diskUuid}`;
        }
    } catch {}

    // Final fallback: Generate hash from hostname + timestamp
    const hostname = typeof window === 'undefined' 
        ? require('os').hostname() 
        : 'browser';
    
    const hash = createHash('sha256')
        .update(hostname + Date.now().toString())
        .digest('hex')
        .substring(0, 32);
    
    return `GEN-${hash.toUpperCase()}`;
}


//TerminalHUD interface below

/**
 * TerminalHUD - A framework for creating HUD interfaces in terminal
 * Optional mouse support: click to focus, double-click to select, wheel to navigate.
 * Now extends EventEmitter for event-driven architecture.
 * 
 * @class TerminalHUD
 * @extends {EventEmitter}
 */
class TerminalHUD extends EventEmitter {
  /**
   * Creates an instance of TerminalHUD
   * @constructor
   * @param {object} configuration - Configuration options
   * @param {boolean} [configuration.numberedMenus=false] - Use numbered menus instead of arrow navigation
   * @param {string} [configuration.highlightColor='blue'] - Color for highlighting selected menu option
   * @param {boolean} [configuration.mouseSupport=true] - Enable mouse click/double-click navigation
   * @param {boolean} [configuration.mouseWheel] - Enable mouse wheel navigation (defaults to mouseSupport value)
   * @param {boolean} [configuration.enableEvents=true] - Enable event emission
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

  /**
   * Emits an event with the given name and data
   * @private
   * @param {string} eventName - The name of the event to emit
   * @param {object} [eventData={}] - Additional data to include with the event
   */
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

  /**
   * Gets ANSI background color code for a given color name
   * @private
   * @param {string} color - Color name (red, green, yellow, blue, magenta, cyan, white)
   * @returns {string} ANSI escape sequence for the background color
   */
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

  /**
   * Resets terminal colors to default
   * @private
   * @returns {string} ANSI reset sequence
   */
  resetColor() {
    return '\x1b[0m';
  }

  /**
   * Starts a loading animation in the terminal
   * @private
   */
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

  /**
   * Stops the loading animation
   * @private
   */
  stopLoading() {
    this.isLoading = false;
    clearInterval(this.loadingInterval);
    stdout.clearLine();
    stdout.cursorTo(0);
    
    // Emit loading stop event
    this.emitEvent(this.eventTypes.LOADING_STOP);
  }

  // Public API

  /**
   * Resets terminal modes to default state
   * @private
   */
  resetTerminalModes() {
    // Write all terminal reset commands
    stdout.write('\x1b[?1000l'); // Disable mouse tracking
    stdout.write('\x1b[?1002l'); // Disable mouse drag tracking
    stdout.write('\x1b[?1003l'); // Disable all mouse tracking
    stdout.write('\x1b[?1006l'); // Disable SGR mouse mode
    stdout.write('\x1b[?25h');   // Show cursor
    stdout.write(''); // Force flush
  }

  /**
   * Cleans up mouse support features
   * @private
   */
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

  /**
   * Asks a question to the user
   * @async
   * @param {string} question - The question to ask
   * @param {object} [configuration={}] - Configuration options
   * @param {Array<string|object>} [configuration.options] - Menu options for selection
   * @param {string} [configuration.alert] - Alert message to display
   * @param {string} [configuration.alertEmoji='⚠️'] - Emoji for alert message
   * @param {boolean} [configuration.clearScreen=true] - Whether to clear screen before display
   * @param {number} [configuration.initialSelectedIndex=0] - Initial selected index
   * @param {number} [configuration.selectedIncrement=0] - Increment to apply to selected index
   * @param {any} [configuration.props] - Additional properties to pass to menu generator
   * @returns {Promise<string|any>} The user's answer or selected option
   * 
   * @emits TerminalHUD#question:ask
   * @emits TerminalHUD#question:answer
   * @emits TerminalHUD#menu:display
   * @emits TerminalHUD#menu:selection
   * @emits TerminalHUD#menu:navigation
   */
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

/**
 * Counts total options in a menu structure
 * @private
 * @param {Array<string|object|Array<string|object>>} options - Menu options
 * @returns {number} Total number of options
 */
countMenuOptions(options) {
  if (!Array.isArray(options)) return 0;
  
  let count = 0;
  for (const option of options) {
    if (Array.isArray(option)) {
      count += option.length;
    } else {
      count++;
    }
  }
  return count;
}

  /**
 * Displays a menu generated by a menu generator function or from a raw menu object
 * @async
 * @param {Function|object} menuGeneratorOrObject - Function that generates menu content OR raw menu object
 * @param {object} [configuration={}] - Configuration options
 * @param {any} [configuration.props] - Properties to pass to menu generator
 * @param {boolean} [configuration.clearScreen=true] - Whether to clear screen
 * @param {string} [configuration.alert] - Alert message to display
 * @param {string} [configuration.alertEmoji='⚠️'] - Emoji for alert message
 * @param {number} [configuration.initialSelectedIndex=0] - Initial selected index
 * @param {number} [configuration.selectedIncrement=0] - Increment to apply to selected index
 * @param {boolean} [configuration.remember=false] - Whether to remember the previous selection index if possible
 * @returns {Promise<string|any>} The selected option
 * 
 * @emits TerminalHUD#menu:display
 * @emits TerminalHUD#menu:selection
 * @emits TerminalHUD#menu:navigation
 * @emits TerminalHUD#loading:start
 * @emits TerminalHUD#loading:stop
 */
async displayMenu(menuGeneratorOrObject, configuration = {
  props: {},
  clearScreen: true,
  alert: undefined,
  alertEmoji: '⚠️',
  initialSelectedIndex: 0,
  selectedIncrement: 0,
  remember: false
}) {
  if (configuration.clearScreen) console.clear();
  
  let menu;
  
  // Determine if first parameter is a function or object
  if (typeof menuGeneratorOrObject === 'function') {
    // Handle menu generator function (existing behavior)
    this.startLoading();
    menu = await menuGeneratorOrObject(configuration.props);
    this.stopLoading();
  } else if (typeof menuGeneratorOrObject === 'object' && menuGeneratorOrObject !== null) {
    // Handle raw menu object (new behavior)
    menu = menuGeneratorOrObject;
  } else {
    throw new Error('displayMenu expects either a menu generator function or a menu object');
  }
  
  // Validate menu structure
  if (!menu || typeof menu !== 'object') {
    throw new Error('Invalid menu structure');
  }
  
  if (configuration.alert) {
    console.log(`${configuration.alertEmoji || '⚠️'}  ${configuration.alert}\n`);
  }
  
  // Handle title - it could be a string or a promise
  const menuTitle = typeof menu.title === 'function' 
    ? await menu.title() 
    : (menu.title && typeof menu.title.then === 'function' 
      ? await menu.title 
      : menu.title || '');
  
  // Determine initial index based on configuration and previous state
  let initialIndex = configuration.initialSelectedIndex || 0;
  
  // Apply remember logic: if remember is true, try to use last selected index
  if (configuration.remember && this.lastSelectedIndex !== undefined) {
    // Check if the remembered index is valid for current menu
    const totalOptions = this.countMenuOptions(menu.options);
    if (this.lastSelectedIndex >= 0 && this.lastSelectedIndex < totalOptions) {
      initialIndex = this.lastSelectedIndex;
    }
  }
  
  // Apply any increment configuration
  if (configuration.selectedIncrement) {
    initialIndex = Math.max(0, initialIndex + configuration.selectedIncrement);
  }
  
  // Store reference to menu generator for function case
  if (typeof menuGeneratorOrObject === 'function') {
    this.lastMenuGenerator = menuGeneratorOrObject;
  }
  
  return this.numberedMenus
    ? this.displayMenuFromOptions(menuTitle, menu.options, configuration)
    : this.displayMenuWithArrows(menuTitle, menu.options, configuration, initialIndex);
}

  /**
   * Waits for any key press
   * @async
   * @returns {Promise<void>}
   * 
   * @emits TerminalHUD#press:wait
   * @emits TerminalHUD#key:press
   */
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

  /**
   * Closes the TerminalHUD instance and cleans up resources
   * 
   * @emits TerminalHUD#menu:close
   */
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

  /**
   * Displays a menu with arrow key navigation and optional mouse support
   * @async
   * @private
   * @param {string} question - The menu title/question
   * @param {Array<string|object>} options - Menu options
   * @param {object} [configuration={}] - Configuration options
   * @param {boolean} [configuration.clear=false] - Whether to clear screen
   * @param {number} [initialIndex=0] - Initial selected index
   * @returns {Promise<string|any>} The selected option
   * 
   * @emits TerminalHUD#menu:display
   * @emits TerminalHUD#menu:navigation
   * @emits TerminalHUD#menu:selection
   * @emits TerminalHUD#key:press
   * @emits TerminalHUD#mouse:click
   * @emits TerminalHUD#mouse:doubleclick
   * @emits TerminalHUD#mouse:wheel
   */
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

  /**
   * Sets up the menu state and event listeners
   * @private
   * @param {Function} keyPressHandler - Function to handle key press events
   */
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

  /**
   * Cleans up menu state and event listeners
   * @private
   */
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

  /**
   * Displays a menu with arrow key navigation (original implementation without mouse support)
   * @async
   * @private
   * @param {string} question - The menu title/question
   * @param {Array<string|object>} options - Menu options
   * @param {object} [configuration={}] - Configuration options
   * @param {boolean} [configuration.clear=false] - Whether to clear screen
   * @param {number} [initialIndex=0] - Initial selected index
   * @returns {Promise<string|any>} The selected option
   * 
   * @emits TerminalHUD#menu:display
   * @emits TerminalHUD#menu:navigation
   * @emits TerminalHUD#menu:selection
   * @emits TerminalHUD#key:press
   */
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

  /**
   * Displays a menu with numbered options
   * @async
   * @private
   * @param {string} question - The menu title/question
   * @param {Array<string|object>} options - Menu options
   * @param {object} [configuration={}] - Configuration options
   * @param {boolean} [configuration.clear=true] - Whether to clear screen
   * @returns {Promise<string|any>} The selected option
   * 
   * @emits TerminalHUD#menu:display
   * @emits TerminalHUD#menu:selection
   */
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

  /**
   * Displays a numbered menu with special option types
   * @async
   * @private
   * @param {string} title - The menu title
   * @param {Array<object>} options - Menu options with type property
   * @returns {Promise<string|any>} The selected option
   * 
   * @emits TerminalHUD#menu:display
   * @emits TerminalHUD#menu:selection
   */
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

  /**
   * Normalizes menu options to a consistent format
   * @private
   * @param {Array<string|object|Array<string|object>>} options - Menu options
   * @returns {Array<Array<object>>} Normalized options in 2D array format
   */
  normalizeOptions(options) {
    return options.map(option => {
      if (Array.isArray(option)) return option.map(item => typeof item === 'string' ? { name: item } : item);
      if (option?.type === 'options') return option.value.map(item => typeof item === 'string' ? { name: item } : item);
      return [typeof option === 'string' ? { name: option } : option];
    });
  }

  /**
   * Converts linear index to 2D coordinates
   * @private
   * @param {Array<Array<object>>} lines - 2D array of options
   * @param {number} index - Linear index
   * @returns {{line: number, column: number}} 2D coordinates
   */
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

  /**
   * Converts 2D coordinates to linear index
   * @private
   * @param {Array<Array<object>>} lines - 2D array of options
   * @param {number} line - Row index
   * @param {number} column - Column index
   * @returns {number} Linear index
   */
  getLinearIndexFromCoordinates(lines, line, column) {
    return lines.slice(0, line).reduce((sum, currentLine) => sum + currentLine.length, 0) + column;
  }

  /**
   * Sanitizes options for event emission (removes functions)
   * @private
   * @param {Array<string|object|Array<string|object>>} options - Menu options
   * @returns {Array<object|Array<object>>} Sanitized options
   */
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
  
  /**
   * Gets safe option data for event emission
   * @private
   * @param {string|object} option - Menu option
   * @returns {object|null} Safe option data without functions
   */
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

  /**
   * Safely enables mouse tracking
   * @private
   */
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

  /**
   * Cleans up all resources
   * @private
   */
  cleanupAll() {
    this.isInMenu = false;
    this.cleanupMouseSupport();
    
    if (this.doubleClickTimeout) {
      clearTimeout(this.doubleClickTimeout);
      this.doubleClickTimeout = null;
    }
  }

  /**
   * Resets mouse click state
   * @private
   */
  resetClickState() {
    this.lastMouseClick = { time: 0, x: -1, y: -1 };
    this.isClickInProgress = false;
    
    if (this.doubleClickTimeout) {
      clearTimeout(this.doubleClickTimeout);
      this.doubleClickTimeout = null;
    }
  }

  /**
   * Handles mouse data from terminal
   * @private
   * @param {Buffer|string} data - Raw mouse event data
   */
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

  /**
   * Handles SGR (Standard Generalized Representation) mouse events
   * @private
   * @param {Array<string>} match - Regex match groups
   */
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

  /**
   * Handles X10 mouse events (legacy protocol)
   * @private
   * @param {Array<string>} match - Regex match groups
   */
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

  /**
   * Processes mouse click events
   * @private
   * @param {number} x - X coordinate of click
   * @param {number} y - Y coordinate of click
   */
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

  /**
   * Processes mouse wheel events for navigation
   * @private
   * @param {number} x - X coordinate of wheel event
   * @param {number} y - Y coordinate of wheel event
   * @param {'up'|'down'} direction - Wheel direction
   */
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

  /**
   * Finds the menu option index at given terminal coordinates
   * @private
   * @param {number} terminalY - Terminal Y coordinate
   * @param {number} terminalX - Terminal X coordinate
   * @param {Array<Array<object>>} normalizedOptions - Normalized menu options
   * @param {string} question - Menu question/title
   * @returns {number} Index of the option or -1 if not found
   */
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

// Event type definitions for JSDoc

/**
 * Event emitted when a menu is displayed
 * @event TerminalHUD#menu:display
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {string} question - Menu question/title
 * @property {Array<object|Array<object>>} options - Menu options (sanitized)
 * @property {object} configuration - Configuration object
 * @property {number} [initialIndex] - Initial selected index
 * @property {'arrow'|'arrow-original'|'numbered'|'numbered-from-options'} menuType - Type of menu displayed
 */

/**
 * Event emitted when a menu option is selected
 * @event TerminalHUD#menu:selection
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {number} index - Linear index of selected option
 * @property {number} line - Row index of selected option
 * @property {number} column - Column index of selected option
 * @property {object} selected - Selected option data (sanitized)
 * @property {string} question - Menu question/title
 * @property {'keyboard'|'mouse'|'numbered'} source - Source of selection
 * @property {object} [customData] - Custom data from option
 * @property {object} [metadata] - Metadata from option
 */

/**
 * Event emitted when navigating through menu options
 * @event TerminalHUD#menu:navigation
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {number} line - New row index
 * @property {number} column - New column index
 * @property {number} linearIndex - New linear index
 * @property {string} question - Menu question/title
 */

/**
 * Event emitted when a menu is closed
 * @event TerminalHUD#menu:close
 * @type {object}
 * @property {number} timestamp - Event timestamp
 */

/**
 * Event emitted when asking a question
 * @event TerminalHUD#question:ask
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {string} question - The question being asked
 * @property {object} configuration - Configuration object
 */

/**
 * Event emitted when a question is answered
 * @event TerminalHUD#question:answer
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {string} question - The question that was asked
 * @property {string} answer - The answer provided
 * @property {object} configuration - Configuration object
 */

/**
 * Event emitted when loading starts
 * @event TerminalHUD#loading:start
 * @type {object}
 * @property {number} timestamp - Event timestamp
 */

/**
 * Event emitted when loading stops
 * @event TerminalHUD#loading:stop
 * @type {object}
 * @property {number} timestamp - Event timestamp
 */

/**
 * Event emitted on mouse click
 * @event TerminalHUD#mouse:click
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {number} x - X coordinate of click
 * @property {number} y - Y coordinate of click
 * @property {'left'|'right'|'middle'} button - Mouse button
 * @property {number} buttonCode - Raw button code
 */

/**
 * Event emitted on mouse double click
 * @event TerminalHUD#mouse:doubleclick
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {number} x - X coordinate of click
 * @property {number} y - Y coordinate of click
 * @property {'left'|'right'|'middle'} button - Mouse button
 */

/**
 * Event emitted on mouse wheel scroll
 * @event TerminalHUD#mouse:wheel
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {number} x - X coordinate of wheel event
 * @property {number} y - Y coordinate of wheel event
 * @property {'up'|'down'} direction - Wheel direction
 * @property {number} buttonCode - Raw button code
 */

/**
 * Event emitted on key press
 * @event TerminalHUD#key:press
 * @type {object}
 * @property {number} timestamp - Event timestamp
 * @property {string} [key] - Key name (for keypress events)
 * @property {string} [sequence] - Raw key sequence
 * @property {boolean} [ctrl] - Ctrl key pressed
 * @property {boolean} [shift] - Shift key pressed
 * @property {boolean} [meta] - Meta key pressed
 * @property {boolean} [inMenu] - Whether in menu context
 * @property {string} [key] - Key character (for generic key press)
 * @property {boolean} [isCtrlC] - Whether it's Ctrl+C
 */

/**
 * Event emitted when waiting for key press
 * @event TerminalHUD#press:wait
 * @type {object}
 * @property {number} timestamp - Event timestamp
 */

/**
 * Wildcard event emitted for all events
 * @event TerminalHUD#*
 * @type {object}
 * @property {string} event - Original event name
 * @property {number} timestamp - Event timestamp
 * @property {object} [additionalData] - Original event data
 */


// --------------------------- Util interfaces --------------------------------------------


class Session {
  constructor(config = {uniqueid : undefined,machine_id : undefined,process_id : undefined,userid : undefined,external : false}){
    this.MachineID = config.machine_id || ''
    this.ProcessID = config.process_id || undefined
    this.UserID = config.userid || undefined
    this.External = config.external || false
    this.UniqueID = config.uniqueid || `${this.MachineID}-P${this.ProcessID}`
    this.ActualPath = undefined
    this.PreviousPath = undefined
    this.ActualProps = undefined
    this.PreviousProps = undefined
  }
}

class userBuild {
  constructor(data = {session : new Session}){
    this.Session = data.session || new Session()
    this.UniqueID = this.Session.UniqueID
    this.MachineID = this.Session.MachineID
    this.ProcessID = this.Session.ProcessID || undefined
    this.UserID = this.Session.UserID || undefined
    this.Text = ''
    this.Buttons = []
  }

}

//--------------------------- SyAPP Structure start below ----------------------------------

class SyAPP_Func {
    constructor(name,build = async (props = {session : new Session}) => {},config = {userid_only : false,log : false,linked : []}){
        this.Name = name
        this.Linked = config.linked || []
        this.Log = config.log || false
        this.UserID_Only = config.userid_only || false

    /** @type {Map<string, userBuild>} */
    this.Builds = new Map()

      this.WaitLog = async (message,ms = 5000) => {
        console.log(message)
        await new Promise(resolve => setTimeout(resolve, ms));
      }

      this.Button = (id,config = {name : undefined,path : this.Name,props : {},action : () => {},resetSelection : false,buttons : false}) => {
        if(this.Builds.has(id)){
            if(!config.path){config.path = this.Name}
            let button_obj = {
              name : config.name || '',
              metadata : {props : config.props || {},path : config.path || this.Name,resetSelection : config.resetSelection || false}, 
              action : (config.action) ? config.action : () => {},
            }
            if(config.buttons){
              if(this.Builds.get(id).Buttons[this.Builds.get(id).Buttons.length-1].type){
                if(this.Builds.get(id).Buttons[this.Builds.get(id).Buttons.length-1].type == 'options'){
                  this.Builds.get(id).Buttons[this.Builds.get(id).Buttons.length-1].value.push(button_obj)
                }
              } else {
                this.Builds.get(id).Buttons.push({type : 'options',value : [button_obj]})
              }
            } else {
              this.Builds.get(id).Buttons.push(button_obj)
            }
            
        } else {
            if(this.Log){console.log(`This.Button() Error - userBuild not founded | Text : ${text} | BuildID : ${id} | Path : ${path}`)}
        }
      }

      this.SideButton = (id, config = {}) => {
        // Call this.Button with forced buttons: true
        return this.Button(id, {
            ...config,
            buttons: true  // Force buttons to be true
        });
    };

    
      this.Text = (id,text,config = {}) => {
        if(this.Builds.has(id)){
          if(this.Builds.get(id).Text != ''){
            this.Builds.get(id).Text = `${this.Builds.get(id).Text}\n${text}`
          } else {
            this.Builds.get(id).Text = text
          }
            
        } else {
            if(this.Log){console.log(`This.Text() Error - userBuild not founded | Text : ${text} | BuildID : ${id} | Path : ${path}`)}
        }

      }


      this.Build = async (props = {session : new Session}) => {
        this.Builds.set(props.session.UniqueID,new userBuild({session : props.session}))
        await build(props)
        let obj_return = {
          hud_obj : {
            title : this.Builds.get(props.session.UniqueID).Text,
            options : this.Builds.get(props.session.UniqueID).Buttons
          }
        }
        this.Builds.delete(props.session.UniqueID)
        return obj_return
      }

      }
}


class TemplateFunc extends SyAPP_Func {
  constructor(){
    super(
      'templatefunc',
      async (props) => {
      let uid = props.session.UniqueID
      
      //await this.WaitLog(props,2000)
      

      this.Text(uid,'Hello World')
      this.Button(uid,{name : 'Button 1'})
      this.SideButton(uid,{name : 'Button 2'})
      this.SideButton(uid,{name : 'Button 3',resetSelection : true})
      this.Button(uid,{name : 'Button 4',resetSelection : true})
      this.Button(uid,{name : 'Button 5',props : {testando : true}})
      if(props.testando){
        this.Button(uid,{name : 'Button 6'})
      }
      

      }
    )
  }
}


class SyAPP extends TerminalHUD {
  constructor(config = {mainfunc : TemplateFunc, userid_only : false}){
      super()
      

      this.MainFunc = {Func : config.mainfunc || TemplateFunc,Name : undefined}
      this.MainFunc.Name = new this.MainFunc.Func().Name
      this.HUD = new TerminalHUD()
      
      /** @type {Map<string, SyAPP_Func>} */
      this.Funcs = new Map()
      
      this.MainSessionID = `${getMachineID()}-P${process.pid}`

      /** @type {Map<string, Session>} */
      this.Sessions = new Map([[this.MainSessionID, new Session({
          machine_id: getMachineID(),
          process_id: process.pid
      })]])

    this.ProcessFuncs = (FuncClass) => {
          const tempInstance = new FuncClass()
          const funcName = tempInstance.Name
          
          if (this.Funcs.has(funcName)) {
              return
          }
          
          const instance = new FuncClass()
          this.Funcs.set(funcName, instance)
          
          instance.Linked.forEach(linkedFunc => {
              const linkedTemp = new linkedFunc()
              if (!this.Funcs.has(linkedTemp.Name)) {
                  this.ProcessFuncs(linkedFunc)
              }
          })
      }

      this.ProcessFuncs(this.MainFunc.Func)

      this.LoadScreen = async (funcname = this.MainFunc.Name,config = {resetSelection : false,props : {}}) => { 
        if(this.Funcs.has(funcname)){
          if(!config.props){config.props = {}}
          
          this.Sessions.get(this.MainSessionID).PreviousPath = this.Sessions.get(this.MainSessionID).ActualPath
          this.Sessions.get(this.MainSessionID).ActualPath = funcname
          this.Sessions.get(this.MainSessionID).PreviousProps = this.Sessions.get(this.MainSessionID).ActualProps
          config.props.session = this.Sessions.get(this.MainSessionID)
          this.Sessions.get(this.MainSessionID).ActualProps = config.props
          
          let return_obj = await this.Funcs.get(funcname).Build(config.props)
          this.displayMenu(return_obj.hud_obj,{remember : (!config.resetSelection) ? true : false})
        } else {
          console.log('Func não encontrada')
        }
      }

      this.on(this.eventTypes.MENU_SELECTION,(e) => {
          
          this.LoadScreen(e.metadata.path,{resetSelection : e.metadata.resetSelection || false,props : e.metadata.props})
      })

      this.LoadScreen()
  }
}

export default SyAPP

//new SyAPP()