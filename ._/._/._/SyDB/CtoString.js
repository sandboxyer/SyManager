import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Converts a C file to a JavaScript module with the C code as a template string
 * @param {string} cFilePath - Path to the .c file
 * @param {string} outputFilePath - Path for the output .js file
 * @param {Object} options - Configuration options
 * @returns {Object} Result object with conversion details
 */
export function CtoString(cFilePath, outputFilePath, options = {}) {
    // Validate inputs
    if (typeof cFilePath !== 'string') {
        throw new Error('C file path must be a string');
    }
    if (typeof outputFilePath !== 'string') {
        throw new Error('Output file path must be a string');
    }
    
    // Check if C file exists
    if (!fs.existsSync(cFilePath)) {
        throw new Error(`C file not found: ${cFilePath}`);
    }
    if (!cFilePath.endsWith('.c')) {
        throw new Error('Input file must be a .c file');
    }
    if (!outputFilePath.endsWith('.js')) {
        throw new Error('Output file must have .js extension');
    }

    try {
        // Read the C file content
        const cCode = fs.readFileSync(cFilePath, 'utf8');
        
        // Generate a safe variable name from the filename
        const baseName = path.basename(cFilePath, '.c');
        const safeVarName = generateSafeVarName(baseName);

        // Escape the C code for template string
        const escapedCCode = escapeForTemplateString(cCode);

        // Generate JavaScript module content
        const jsContent = generateESModuleContent(cFilePath, safeVarName, escapedCCode, options);

        // Ensure output directory exists
        const outputDir = path.dirname(outputFilePath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Write the JavaScript file
        fs.writeFileSync(outputFilePath, jsContent, 'utf8');
        
        console.log(`✅ Successfully created ${outputFilePath}`);
        console.log(`📦 C code wrapped in const: ${safeVarName}`);
        
        return {
            success: true,
            variableName: safeVarName,
            inputFile: cFilePath,
            outputFile: outputFilePath,
            codeLength: cCode.length,
            escapedLength: escapedCCode.length
        };
        
    } catch (error) {
        throw new Error(`Failed to create JS wrapper: ${error.message}`);
    }
}

/**
 * Advanced version with additional features
 */
export function CtoStringAdvanced(cFilePath, outputFilePath, options = {}) {
    const defaultOptions = {
        minify: false,
        addHeaders: true,
        validateCSyntax: false,
        includeSourceMap: false,
        exportName: null,
        ...options
    };

    // Validate inputs
    if (typeof cFilePath !== 'string') {
        throw new Error('C file path must be a string');
    }
    if (typeof outputFilePath !== 'string') {
        throw new Error('Output file path must be a string');
    }
    
    // Check if C file exists and is readable
    if (!fs.existsSync(cFilePath)) {
        throw new Error(`C file not found: ${cFilePath}`);
    }
    
    const stats = fs.statSync(cFilePath);
    if (stats.size === 0) {
        throw new Error('C file is empty');
    }
    if (stats.size > 10 * 1024 * 1024) {
        throw new Error('C file too large (max 10MB)');
    }

    if (!cFilePath.endsWith('.c')) {
        throw new Error('Input file must be a .c file');
    }
    if (!outputFilePath.endsWith('.js')) {
        throw new Error('Output file must have .js extension');
    }

    try {
        // Read the C file content
        const cCode = fs.readFileSync(cFilePath, 'utf8');
        
        // Basic C syntax validation (optional)
        if (defaultOptions.validateCSyntax) {
            validateBasicCSyntax(cCode);
        }

        // Generate a safe variable name
        const baseName = path.basename(cFilePath, '.c');
        const safeVarName = defaultOptions.exportName || generateSafeVarName(baseName);

        // Escape the C code
        const escapedCCode = escapeForTemplateString(cCode, defaultOptions.minify);

        // Generate JavaScript content
        const jsContent = generateESModuleContent(cFilePath, safeVarName, escapedCCode, defaultOptions);

        // Ensure output directory exists
        const outputDir = path.dirname(outputFilePath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true, mode: 0o755 });
        }

        // Write the JavaScript file
        fs.writeFileSync(outputFilePath, jsContent, 'utf8');
        
        // Set appropriate file permissions
        fs.chmodSync(outputFilePath, 0o644);
        
        const result = {
            success: true,
            variableName: safeVarName,
            inputFile: cFilePath,
            outputFile: outputFilePath,
            codeLength: cCode.length,
            escapedLength: escapedCCode.length
        };
        
        console.log(`✅ Successfully created ${outputFilePath}`);
        console.log(`📦 C code wrapped in const: ${safeVarName}`);
        console.log(`📊 Original size: ${cCode.length} bytes, Escaped: ${escapedCCode.length} bytes`);
        
        return result;
        
    } catch (error) {
        console.error(`❌ Failed to create JS wrapper: ${error.message}`);
        throw error;
    }
}

/**
 * Generates a safe JavaScript variable name
 */
function generateSafeVarName(baseName) {
    return baseName
        .replace(/[^a-zA-Z0-9_$]/g, '_')
        .replace(/^[0-9]/, '_$&')
        .replace(/_+/g, '_')
        .substring(0, 50);
}

/**
 * Escapes C code for safe use in template strings
 */
function escapeForTemplateString(code, minify = false) {
    let processed = code;
    
    // Normalize line endings
    processed = processed.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Minify if requested
    if (minify) {
        processed = processed
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '')
            .replace(/\s+/g, ' ')
            .replace(/\s*([{}();,=+\-*\/])\s*/g, '$1')
            .trim();
    }
    
    // Escape template string special characters
    return processed
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t')
        .replace(/\r/g, '\\r');
}

/**
 * Generates ES module content with export default
 */
function generateESModuleContent(cFilePath, varName, escapedCode, options) {
    const headers = options.addHeaders ? `/**
 * Auto-generated wrapper for C file: ${path.basename(cFilePath)}
 * Original path: ${cFilePath}
 * Generated on: ${new Date().toISOString()}
 * File size: ${escapedCode.length} characters (escaped)
 */
` : '';

    return `${headers}const ${varName} = \`${escapedCode}\`;

export default ${varName};
`;
}

/**
 * Basic C syntax validation
 */
function validateBasicCSyntax(code) {
    const lines = code.split('\n');
    
    const hasMain = code.includes('int main') || code.includes('void main') || code.includes('main(');
    const hasIncludes = code.includes('#include');
    const hasBraces = code.includes('{') && code.includes('}');
    const hasSemicolons = code.includes(';');
    
    if (!hasMain && !hasIncludes && lines.length > 10) {
        console.warn('⚠️  Warning: File does not appear to be a standard C file');
    }
    
    const blockComments = (code.match(/\/\*/g) || []).length;
    const blockCommentEnds = (code.match(/\*\//g) || []).length;
    if (blockComments !== blockCommentEnds) {
        throw new Error('Unclosed block comment detected');
    }
}

/**
 * Batch convert multiple C files
 */
export async function batchConvertCFiles(files, outputDir, options = {}) {
    const results = [];
    
    for (const file of files) {
        try {
            const outputFile = path.join(outputDir, `${path.basename(file, '.c')}.js`);
            const result = CtoStringAdvanced(file, outputFile, options);
            results.push(result);
        } catch (error) {
            results.push({
                success: false,
                file,
                error: error.message
            });
        }
    }
    
    return results;
}

/**
 * CLI interface
 */
function runCLI() {
    const args = process.argv.slice(2);
    
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        showHelp();
        process.exit(0);
    }
    
    if (args.includes('--version') || args.includes('-v')) {
        console.log('CtoString v1.0.0');
        process.exit(0);
    }
    
    const cFilePath = args[0];
    let outputFilePath = args[1];
    
    // Generate default output path if not provided
    if (!outputFilePath) {
        const baseName = path.basename(cFilePath, '.c');
        outputFilePath = path.join(path.dirname(cFilePath), `${baseName}.js`);
    }
    
    // Ensure output has .js extension
    if (!outputFilePath.endsWith('.js')) {
        outputFilePath += '.js';
    }
    
    const options = {
        minify: args.includes('--minify'),
        addHeaders: !args.includes('--no-headers'),
        validateCSyntax: args.includes('--validate')
    };
    
    try {
        CtoStringAdvanced(cFilePath, outputFilePath, options);
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        process.exit(1);
    }
}

/**
 * Show CLI help
 */
function showHelp() {
    console.log(`
Usage: c-to-string <input.c> [output.js] [options]

Convert C files to JavaScript modules with the C code as template strings.

Arguments:
  input.c                Path to the input C file (required)
  output.js              Path to the output JS file (optional, defaults to same name as input)

Options:
  --minify               Minify the C code before embedding
  --no-headers           Skip adding header comments to the output
  --validate             Perform basic C syntax validation
  -h, --help            Show this help message
  -v, --version         Show version information

Examples:
  c-to-string program.c
  c-to-string program.c output.js
  c-to-string program.c --minify --validate
  c-to-string program.c output.js --minify --no-headers
`);
}

// Check if the script is being run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    runCLI();
}

// Default export
export default CtoString;
