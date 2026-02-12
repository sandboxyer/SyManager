import readline from 'readline';
import { stdin, stdout } from 'process';
import EventEmitter from 'events';

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
 * Counts total options in a menu structure, properly handling groups
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
    } else if (option && option.type === 'options') {
      // Count each item in the options group
      count += option.value.length;
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
 * @param {number} [configuration.selectedIncrement=0] - Increment to apply to selected index (deprecated, use jumpToIndex instead)
 * @param {boolean} [configuration.remember=false] - Whether to remember the previous selection index if possible
 * @param {number} [configuration.jumpToIndex=0] - Jump forward/backward this many positions from the base index
 * @param {boolean} [configuration.jumpFromLast=false] - If true, jump from the last index when jumpToIndex is negative
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
  remember: false,
  jumpToIndex: 0,
  jumpFromLast: false
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
  
  // Get total number of options
  const totalOptions = this.countMenuOptions(menu.options);
  
  // Determine base index
  let baseIndex;
  
  if (configuration.remember && this.lastSelectedIndex !== undefined) {
    // Use remembered index as base if valid
    baseIndex = (this.lastSelectedIndex >= 0 && this.lastSelectedIndex < totalOptions) 
      ? this.lastSelectedIndex 
      : (configuration.initialSelectedIndex || 0);
  } else {
    // Use initialSelectedIndex as base
    baseIndex = configuration.initialSelectedIndex || 0;
  }
  
  // Apply selectedIncrement for backward compatibility
  if (configuration.selectedIncrement) {
    configuration.jumpToIndex = (configuration.jumpToIndex || 0) + configuration.selectedIncrement;
  }
  
  // Calculate final index based on jump configuration
  let finalIndex = baseIndex;
  
  if (configuration.jumpToIndex) {
    if (configuration.jumpToIndex > 0) {
      // Positive jump: always jump forward from base index
      finalIndex = Math.min(baseIndex + configuration.jumpToIndex, totalOptions - 1);
    } else if (configuration.jumpToIndex < 0) {
      if (configuration.jumpFromLast) {
        // Jump backward from the last index
        finalIndex = Math.max(0, totalOptions - 1 + configuration.jumpToIndex);
      } else {
        // Jump backward from base index
        finalIndex = Math.max(0, baseIndex + configuration.jumpToIndex);
      }
    }
  }
  
  // Ensure finalIndex is within bounds
  finalIndex = Math.max(0, Math.min(finalIndex, totalOptions - 1));
  
  // Store reference to menu generator for function case
  if (typeof menuGeneratorOrObject === 'function') {
    this.lastMenuGenerator = menuGeneratorOrObject;
  }
  
  // Emit menu display event with jump information
  this.emitEvent(this.eventTypes.MENU_DISPLAY, {
    question: menuTitle,
    options: this.sanitizeOptionsForEvent(menu.options),
    configuration: {
      ...configuration,
      baseIndex,
      finalIndex,
      totalOptions
    },
    menuType: this.numberedMenus ? 'numbered' : 'arrow'
  });
  
  return this.numberedMenus
    ? this.displayMenuFromOptions(menuTitle, menu.options, { ...configuration, initialSelectedIndex: finalIndex })
    : this.displayMenuWithArrows(menuTitle, menu.options, configuration, finalIndex);
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
          
          // Return the selected item for resolution
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
 * Normalizes menu options to a consistent format, handling groups
 * @private
 * @param {Array<string|object|Array<string|object>>} options - Menu options
 * @returns {Array<Array<object>>} Normalized options in 2D array format
 */
normalizeOptions(options) {
  const result = [];
  
  for (const option of options) {
    if (Array.isArray(option)) {
      // Handle array of options (already flattened)
      const line = option.map(item => 
        typeof item === 'string' ? { name: item } : item
      );
      result.push(line);
    } else if (option?.type === 'options') {
      // Handle options group - flatten it into the current line
      const line = option.value.map(item => 
        typeof item === 'string' ? { name: item } : item
      );
      result.push(line);
    } else {
      // Single option
      const item = typeof option === 'string' ? { name: option } : option;
      result.push([item]);
    }
  }
  
  return result;
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
  
  // Handle options group
  if (option.type === 'options') {
    return {
      type: 'options',
      value: option.value.map(item => this.getOptionDataForEvent(item))
    };
  }
  
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

export default TerminalHUD;