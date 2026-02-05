#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { Buffer } from 'buffer';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Template for the self-extracting JavaScript file
const JS_TEMPLATE = `#!/usr/bin/env node

import fs from 'fs';
import { Buffer } from 'buffer';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function extractCFile() {
    const scriptName = path.basename(__filename);
    const outputFile = scriptName.replace(/\\.js$/, '.c');
    
    if (fs.existsSync(outputFile)) {
        console.log(\`Overwriting: \${outputFile}\`);
    }
    
    try {
        // Base64 encoded C file content
        const base64Content = \`{BASE64_CONTENT}\`;
        const fileContent = Buffer.from(base64Content, 'base64');
        
        fs.writeFileSync(outputFile, fileContent);
        const stats = fs.statSync(outputFile);
        
        console.log(\`✅ Successfully extracted: \${outputFile}\`);
        console.log(\`   Size: \${stats.size} bytes\`);
        
        // Verify it's a C file
        const firstLines = fs.readFileSync(outputFile, 'utf8', 0, 200);
        if (firstLines.includes('#include') || /^\\s*int\\s+main/.test(firstLines)) {
            console.log(\`   Verified: Valid C source code\`);
        }
        
        console.log(\`\\n📦 Next steps:\`);
        console.log(\`   Compile: gcc \${outputFile} -o program\`);
        console.log(\`   Execute: ./program\`);
        
    } catch (error) {
        console.error(\`❌ Extraction failed: \${error.message}\`);
        process.exit(1);
    }
}

// Run extraction
extractCFile().catch(console.error);
`;

async function processCFile(inputFile) {
    try {
        if (!fs.existsSync(inputFile)) {
            console.error(`❌ File not found: ${inputFile}`);
            return false;
        }

        const filename = path.basename(inputFile);
        if (!filename.endsWith('.c')) {
            console.error(`❌ Not a C file: ${filename}`);
            return false;
        }

        const outputName = filename.replace(/\.c$/, '.js');
        const fileBuffer = fs.readFileSync(inputFile);
        const base64Content = fileBuffer.toString('base64');
        
        // Create the JavaScript file
        const jsContent = JS_TEMPLATE.replace('{BASE64_CONTENT}', base64Content);
        fs.writeFileSync(outputName, jsContent, { mode: 0o755 });
        
        console.log(`✅ Created: ${outputName}`);
        console.log(`   Original: ${filename} (${fileBuffer.length} bytes)`);
        console.log(`   To extract: node ${outputName}\n`);
        
        return true;
        
    } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        return false;
    }
}

async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log(`
🔧 C to JavaScript Embedder
Usage: node embed-c.js <file.c> [file2.c ...]
       node embed-c.js <directory>

Examples:
  node embed-c.js hello.c
  node embed-c.js *.c
  node embed-c.js src/
        `);
        return;
    }

    let successCount = 0;
    
    for (const arg of args) {
        try {
            const stat = fs.statSync(arg);
            
            if (stat.isDirectory()) {
                const files = fs.readdirSync(arg)
                    .filter(f => f.endsWith('.c'))
                    .map(f => path.join(arg, f));
                
                console.log(`📁 Processing directory: ${arg} (${files.length} .c files)`);
                
                for (const file of files) {
                    if (await processCFile(file)) {
                        successCount++;
                    }
                }
                
            } else if (stat.isFile() && arg.endsWith('.c')) {
                if (await processCFile(arg)) {
                    successCount++;
                }
            }
        } catch (error) {
            console.log(`⚠️  Skipping '${arg}': ${error.message}`);
        }
    }
    
    console.log(`\n📊 Summary: Created ${successCount} self-extracting .js file(s)`);
}

main().catch(console.error);
