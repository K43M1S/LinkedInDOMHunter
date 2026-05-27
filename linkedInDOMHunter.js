#!/usr/bin/env node

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs').promises;

puppeteer.use(StealthPlugin());

class LinkedInHunter {
    constructor() {
        this.employees = [];
    }

    log(message, type = 'INFO') {
        const prefix = type === 'INFO' ? '[*]' : (type === 'SUCCESS' ? '[+]' : '[-]');
        console.log(`${prefix} ${message}`);
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async run(companyUrl, normalize = false, outputFile = null, limit = null) {
        this.log(`Target: ${companyUrl}`, 'INFO');

        const browser = await puppeteer.launch({
            headless: false,
            defaultViewport: { width: 1920, height: 1080 }
        });

        const page = await browser.newPage();

        console.log('\n============================================================');
        console.log('MANUAL LOGIN REQUIRED');
        console.log('============================================================');
        console.log('1. A browser window will open');
        console.log('2. Log in to LinkedIn if you are not already logged in');
        console.log('3. Return here and press ENTER when ready');
        console.log('============================================================\n');

        await page.goto('https://www.linkedin.com', { waitUntil: 'networkidle2' });
        
        await new Promise(resolve => {
            process.stdin.once('data', resolve);
        });

        const peopleUrl = companyUrl.replace(/\/$/, '') + '/people/';
        this.log(`Navigating to: ${peopleUrl}`, 'INFO');
        await page.goto(peopleUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.delay(3000);

        this.log(`Extracting employees...`, 'INFO');
        
        let hasMoreResults = true;
        let pageNum = 1;

        while (hasMoreResults) {
            this.log(`Page ${pageNum} - extracting profiles...`, 'INFO');
            
            await page.waitForSelector('li.grid.org-people-profile-card__profile-card-spacing', { timeout: 15000 });
            
            const newEmployees = await this.extractNames(page);
            
            const uniqueNew = newEmployees.filter(name => !this.employees.includes(name));
            this.employees.push(...uniqueNew);
            
            this.log(`Found ${uniqueNew.length} new (Total: ${this.employees.length})`, 'SUCCESS');
            
            if (limit && this.employees.length >= limit) {
                this.log(`Limit of ${limit} reached. Stopping extraction.`, 'INFO');
                this.employees = this.employees.slice(0, limit);
                break;
            }
            
            const loadMoreButton = await page.$('button.scaffold-finite-scroll__load-button');
            
            if (loadMoreButton) {
                const isVisible = await page.evaluate(btn => {
                    const style = window.getComputedStyle(btn);
                    return style.display !== 'none' && style.visibility !== 'hidden';
                }, loadMoreButton);
                
                if (isVisible) {
                    this.log(`Loading more results...`, 'INFO');
                    await loadMoreButton.click();
                    await this.delay(3000);
                    pageNum++;
                } else {
                    hasMoreResults = false;
                }
            } else {
                hasMoreResults = false;
            }
        }

        await browser.close();
        
        // Remove duplicates just in case
        this.employees = [...new Set(this.employees)];

        if (normalize) {
            this.log('Normalizing extracted names...', 'INFO');
            try {
                const normalized = [];
                for (const name of this.employees) {
                    const norm = this.normalizeName(name);
                    if (norm) normalized.push(norm);
                }
                this.employees = [...new Set(normalized)];
                this.log(`Normalization complete. Total valid names: ${this.employees.length}`, 'SUCCESS');
            } catch (err) {
                this.log(`Failed to normalize: ${err.message}`, 'ERROR');
            }
        }
        
        this.displayResults();
        await this.saveResults(companyUrl, outputFile);
        
        return this.employees;
    }

    normalizeName(name) {
        if (!name || name.toLowerCase().includes('linkedin')) return null;

        // Parse out titles and suffixes (anything after comma, parenthesis, or pipe)
        let parsedName = name.split(/[,(|]/)[0];

        // Generic Unicode Normalization (removes diacritics/accents)
        let normalized = parsedName.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        
        // Remove any word ending in a period (e.g. Dr., Mr., J., Prof.)
        normalized = normalized.replace(/\b[a-zA-Z]+\./gi, '');
        
        // Remove anything that is not an english letter or space
        normalized = normalized.replace(/[^a-zA-Z\s]/g, ' ');

        // Split into parts, ignoring empty spaces and single letters
        const parts = normalized.split(/\s+/).filter(p => p.length > 1);
        
        // Return null if we don't have at least a first and last name
        return parts.length >= 2 ? parts.join(' ') : null;
    }

    async extractNames(page) {
        return await page.evaluate(() => {
            const names = [];
            const profileCards = document.querySelectorAll('li.grid.org-people-profile-card__profile-card-spacing');
            
            profileCards.forEach(card => {
                try {
                    let name = '';
                    const nameElement = card.querySelector('.artdeco-entity-lockup__title .lt-line-clamp');
                    if (nameElement) {
                        name = nameElement.innerText.trim();
                    }
                    
                    if (!name) {
                        const altName = card.querySelector('.lt-line-clamp--single-line');
                        if (altName) name = altName.innerText.trim();
                    }
                    
                    if (name && name.length > 3 && !name.includes('LinkedIn Member')) {
                        names.push(name);
                    }
                } catch(e) {}
            });
            
            return names;
        });
    }

    displayResults() {
        console.log('\n============================================================');
        console.log('RESULTS');
        console.log('============================================================');
        console.log(`Total employees found: ${this.employees.length}\n`);
        
        if (this.employees.length === 0) {
            console.log('No employees found. Check:');
            console.log('  - LinkedIn session is active');
            console.log('  - The company has employees listed');
            console.log('  - The URL is correct');
            return;
        }
        
        console.log('EMPLOYEE LIST:');
        console.log('------------------------------------------------------------');
        
        this.employees.forEach((name, index) => {
            console.log(`${(index + 1).toString().padStart(4)}. ${name}`);
        });
        
        console.log('------------------------------------------------------------');
    }

    async saveResults(companyUrl, outputFile) {
        if (this.employees.length === 0) return;
        
        const companyName = companyUrl.match(/company\/([^\/]+)/)[1];
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        
        let txtName = `employees_${companyName}_${timestamp}.txt`;

        if (outputFile) {
            const ext = require('path').extname(outputFile);
            if (ext) {
                const base = outputFile.slice(0, -ext.length);
                txtName = `${base}.txt`;
            } else {
                txtName = `${outputFile}.txt`;
            }
        }
        
        const txtContent = this.employees.join('\n');
        await fs.writeFile(txtName, txtContent);
        
        console.log(`\n[+] Results saved to:`);
        console.log(`    - ${txtName}`);
    }
}


async function help(){
console.log(`
USAGE:
  node linkedinSpray.js -u <company_url> [-n] [-o <output_file>] [-l <limit>]

OPTIONS:
  -u, --url       LinkedIn company page URL
  -n, --normalize Apply generic name normalization
  -o, --output    Specific output base filename
  -l, --limit     Maximum number of profiles to extract
  -h, --help      Show this help message

EXAMPLE:
  node linkedinSpray.js -u "https://www.linkedin.com/company/microsoft/" -n -l 50 -o results_microsoft

NOTE: 
  - Use the company main page URL. The script will automatically go to the /people/ tab
  - You must have an active LinkedIn session
`);
}   

async function main() {
    const args = process.argv.slice(2);
    let companyUrl = '';
    let normalize = false;
    let outputFile = null;
    let limit = null;
    
console.log(`
╔════════════════════════════════════════════════╗
║           LinkedIn Employee Hunter             ║
║            DOM Scrapper by K43M1S              ║
╚════════════════════════════════════════════════╝
`);
    
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-u' || args[i] === '--url') {
            companyUrl = args[++i];
        } else if (args[i] === '-n' || args[i] === '--normalize') {
            normalize = true;
        } else if (args[i] === '-o' || args[i] === '--output') {
            outputFile = args[++i];
        } else if (args[i] === '-l' || args[i] === '--limit') {
            limit = parseInt(args[++i], 10);
        } else if (args[i] === '-h' || args[i] === '--help') {
            await help();
            return;
        }
    }
    
    if (!companyUrl) {
        console.error('ERROR: Company URL required (-u or --url)');
        await help();
        process.exit(1);
    }
    
    if (!companyUrl.includes('linkedin.com/company/')) {
        console.error('ERROR: URL must be a LinkedIn company page (linkedin.com/company/...)');
        await help();
        process.exit(1);
    }
    
    const hunter = new LinkedInHunter();
    
    try {
        await hunter.run(companyUrl, normalize, outputFile, limit);
        process.exit(0);
    } catch (error) {
        console.error(`\nERROR: ${error.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = LinkedInHunter;