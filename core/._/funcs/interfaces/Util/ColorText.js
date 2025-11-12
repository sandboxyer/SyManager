class ColorText {
    static red(text) {
        return `\x1b[31m${text}\x1b[0m`; // Red text
    }

    static green(text) {
        return `\x1b[38;5;82m${text}\x1b[0m`; // Green text
    }

    static yellow(text) {
        return `\x1b[33m${text}\x1b[0m`; // Yellow text
    }

    static blue(text) {
        return `\x1b[34m${text}\x1b[0m`; // Blue text
    }

    static magenta(text) {
        return `\x1b[35m${text}\x1b[0m`; // Magenta text
    }

    static cyan(text) {
        return `\x1b[36m${text}\x1b[0m`; // Cyan text
    }

    static white(text) {
        return `\x1b[37m${text}\x1b[0m`; // White text
    }

    static orange(text) {
        return `\x1b[38;5;208m${text}\x1b[0m`; // Orange text
    }

    // Additional colors
    static black(text) {
        return `\x1b[30m${text}\x1b[0m`; // Black text
    }

    static brightRed(text) {
        return `\x1b[91m${text}\x1b[0m`; // Bright red text
    }

    static brightGreen(text) {
        return `\x1b[92m${text}\x1b[0m`; // Bright green text
    }

    static brightYellow(text) {
        return `\x1b[93m${text}\x1b[0m`; // Bright yellow text
    }

    static brightBlue(text) {
        return `\x1b[94m${text}\x1b[0m`; // Bright blue text
    }

    static brightMagenta(text) {
        return `\x1b[95m${text}\x1b[0m`; // Bright magenta text
    }

    static brightCyan(text) {
        return `\x1b[96m${text}\x1b[0m`; // Bright cyan text
    }

    static brightWhite(text) {
        return `\x1b[97m${text}\x1b[0m`; // Bright white text
    }

    static gray(text) {
        return `\x1b[90m${text}\x1b[0m`; // Gray text
    }

    static lightGray(text) {
        return `\x1b[37m${text}\x1b[0m`; // Light gray text (same as white)
    }

    static darkGray(text) {
        return `\x1b[90m${text}\x1b[0m`; // Dark gray text (same as gray)
    }

    static custom(text, colorCode) {
        return `\x1b[38;5;${colorCode}m${text}\x1b[0m`; // Custom color text
    }
}

export default ColorText;