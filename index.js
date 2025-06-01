require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
const blessed = require('blessed'); // Import blessed
const figlet = require('figlet'); // Import figlet
// const chalk = require('chalk'); // Removed as it's not needed with blessed tags

// --- Global UI Elements and State ---
let screen;
let statusBox, walletBox, logBox, menuBox;
let currentStatus = 'Idle';
let activeAccountAddress = 'N/A';
let totalAccounts = 0;
let uploadCountPerWallet = 1; // Default upload count
let activeAccountOgBalance = '0.00'; // Global for active account's OG balance

// --- Custom Logger that writes to blessed logBox ---
// This logger is now configured to use Blessed.js tags for all styling,
// ensuring proper rendering within the blessed.log box.
const logger = {
    // Internal function to log messages to the blessed logBox
    _logToBox: (message) => {
        if (logBox) {
            logBox.log(message); // Log message directly, assuming it's already formatted with blessed tags
            screen.render();
        } else {
            console.log(message); // Fallback to console if logBox is not initialized
        }
    },
    // Public logger methods, now using Blessed.js tags for colors and styles
    // Adjusted spacing for icons to prevent overlap with brackets.
    info: (msg) => logger._logToBox(`{green-fg}{bold}[✓ ]{/bold} ${msg}{/green-fg}`),
    warn: (msg) => logger._logToBox(`{yellow-fg}[⚠ ] ${msg}{/yellow-fg}`),
    error: (msg) => logger._logToBox(`{red-fg}[✗ ] ${msg}{/red-fg}`),
    success: (msg) => logger._logToBox(`{green-fg}{bold}[✅]{/bold} ${msg}{/green-fg}`),
    loading: (msg) => logger._logToBox(`{cyan-fg}[⟳ ] ${msg}{/cyan-fg}`),
    process: (msg) => logger._logToBox(`\n{white-fg}{bold}[➤ ]{/bold} ${msg}{/white-fg}`),
    debug: (msg) => logger._logToBox(`{gray-fg}[… ] ${msg}{/gray-fg}`),
    bye: (msg) => logger._logToBox(`{yellow-fg}[… ] ${msg}{/yellow-fg}`),
    critical: (msg) => logger._logToBox(`{red-fg}{bold}[❌]{/bold} ${msg}{/red-fg}`),
    summary: (msg) => logger._logToBox(`{white-fg}[✓ ] ${msg}{/white-fg}`),
    section: (msg) => {
        const line = '═'.repeat(40); // Creates a line for section separation
        logger._logToBox(`{light-cyan-fg}{bold}${line}{/bold}{/light-cyan-fg}`);
        if (msg) logger._logToBox(`{light-cyan-fg}{bold} ${msg} {/bold}{/light-cyan-fg}`);
        logger._logToBox(`{light-cyan-fg}{bold}${line}\n{/bold}{/light-cyan-fg}`);
    },
    banner: () => {
        // Banner messages for initial display
        logger._logToBox(`{light-cyan-fg}--- 0G Storage Scan Auto Bot - Airdrop Insiders ---{/light-cyan-fg}`);
        logger._logToBox(`{light-cyan-fg}--- Initializing TUI ---{/light-cyan-fg}`);
    },
    clear: () => {
        // Clears the content of the logBox
        if (logBox) {
            logBox.setContent('');
            screen.render();
        }
    }
};

// --- Constants (same as before) ---
const CHAIN_ID = 16601;
const RPC_URL = 'https://evmrpc-testnet.0g.ai';
const CONTRACT_ADDRESS = '0x5f1d96895e442fc0168fa2f9fb1ebef93cb5035e';
const METHOD_ID = '0xef3e12dc';
const PROXY_FILE = 'proxies.txt';
const INDEXER_URL = 'https://indexer-storage-testnet-turbo.0g.ai';
const EXPLORER_URL = 'https://chainscan-galileo.0g.ai/tx/';

const IMAGE_SOURCES = [
    { url: 'https://picsum.photos/800/600', responseType: 'arraybuffer' },
    { url: 'https://loremflickr.com/800/600', responseType: 'arraybuffer' }
];

// --- Ethers.js Version Compatibility ---
const isEthersV6 = ethers.version.startsWith('6');
const parseUnits = isEthersV6 ? ethers.parseUnits : ethers.utils.parseUnits;
const parseEther = isEthersV6 ? ethers.parseEther : ethers.utils.parseEther;
const formatEther = isEthersV6 ? ethers.formatEther : ethers.utils.formatEther;

const provider = isEthersV6
    ? new ethers.JsonRpcProvider(RPC_URL)
    : new ethers.providers.JsonRpcProvider(RPC_URL);

// --- TUI Update Functions ---

// Synchronous function to update the status box content based on global state
function updateStatusDisplay() {
    // Removed "Upload Count" from status bar as requested
    statusBox.setContent(
        `{bold}Status:{/bold} {green-fg}${currentStatus}{/green-fg} | {bold}Active Account:{/bold} ${activeAccountAddress} | {bold}Total Accounts:{/bold} ${totalAccounts} | {bold}OG Balance:{/bold} ${activeAccountOgBalance}`
    );
    screen.render();
}

// Asynchronous function to fetch and update the active account's balance
async function refreshActiveAccountBalance() {
    if (activeAccountAddress !== 'N/A' && privateKeys.length > 0) {
        try {
            // Find the private key corresponding to the active account address
            const activePk = privateKeys.find(pk => new ethers.Wallet(pk).address === activeAccountAddress);
            if (activePk) {
                const wallet = new ethers.Wallet(activePk, provider);
                const rawBalance = await provider.getBalance(wallet.address);
                activeAccountOgBalance = formatEther(rawBalance);
            } else {
                activeAccountOgBalance = 'N/A'; // Should not happen if activeAccountAddress is from privateKeys
            }
        } catch (error) {
            activeAccountOgBalance = 'Error';
            // Log this error to console, not logBox, to avoid spamming logBox on every status update
            console.error(`Error fetching active account balance for status: ${error.message}`);
        }
    } else {
        activeAccountOgBalance = '0.00';
    }
    updateStatusDisplay(); // Update the UI after balance is fetched
}

// Synchronous function to set general status and trigger balance refresh
function setGeneralStatus(status, account = 'N/A', total = 0) {
    currentStatus = status;
    activeAccountAddress = account;
    totalAccounts = total;
    refreshActiveAccountBalance(); // Trigger async balance refresh
}

// Updates the wallet information box with balances
async function updateWalletInfo() {
    walletBox.setContent(`{bold}Wallet Information{/bold}\n\nLoading...`);
    screen.render();

    let walletContent = ``; // Removed the duplicate "Wallet Information" heading
    if (privateKeys.length === 0) {
        walletContent += `No wallets loaded. Please refresh.`;
    } else {
        for (let i = 0; i < privateKeys.length; i++) {
            const tempWallet = new ethers.Wallet(privateKeys[i], provider);
            try {
                const balance = await provider.getBalance(tempWallet.address);
                const formattedBalance = formatEther(balance);
                // Replaced '>' with '➔' arrow icon
                walletContent += ` ➔ {bold}${tempWallet.address}{/bold}\n`;
                walletContent += `    {bold}OG:{/bold} ${formattedBalance}\n`;
                // Removed PHRs, wPHRS, USDT as requested
                if (i < privateKeys.length - 1) walletContent += `\n`;
            } catch (error) {
                walletContent += ` {red}➔ ${tempWallet.address}{/red}\n`;
                walletContent += `    {red}Error fetching balance: ${error.message}{/red}\n`;
                if (i < privateKeys.length - 1) walletContent += `\n`;
            }
        }
    }
    walletBox.setContent(walletContent);
    screen.render();
}

// --- Private Key Management ---
let privateKeys = [];
let currentKeyIndex = 0;

function loadPrivateKeys() {
    privateKeys = []; // Clear existing keys
    try {
        let index = 1;
        let key = process.env[`PRIVATE_KEY_${index}`];

        if (!key && index === 1 && process.env.PRIVATE_KEY) {
            key = process.env.PRIVATE_KEY;
        }

        while (key) {
            if (isValidPrivateKey(key)) {
                privateKeys.push(key);
            } else {
                logger.error(`Invalid private key at PRIVATE_KEY_${index}`);
            }
            index++;
            key = process.env[`PRIVATE_KEY_${index}`];
        }

        if (privateKeys.length === 0) {
            logger.critical('No valid private keys found in .env file');
            setGeneralStatus('Error', 'N/A', 0);
        } else {
            logger.success(`Loaded ${privateKeys.length} private key(s)`);
            totalAccounts = privateKeys.length;
            if (privateKeys.length > 0) {
                activeAccountAddress = new ethers.Wallet(privateKeys[0]).address;
            }
            setGeneralStatus('Idle', activeAccountAddress, totalAccounts);
        }
        updateWalletInfo(); // Update wallet info box after loading
    } catch (error) {
        logger.critical(`Failed to load private keys: ${error.message}`);
        setGeneralStatus('Error', 'N/A', 0);
    }
}

function isValidPrivateKey(key) {
    key = key.trim();
    if (!key.startsWith('0x')) key = '0x' + key;
    try {
        const bytes = Buffer.from(key.replace('0x', ''), 'hex');
        return key.length === 66 && bytes.length === 32;
    } catch (error) {
        return false;
    }
}

function getNextPrivateKey() {
    return privateKeys[currentKeyIndex];
}

// --- Proxy Management (same as before) ---
let proxies = [];
let currentProxyIndex = 0;

function loadProxies() {
    try {
        if (fs.existsSync(PROXY_FILE)) {
            const data = fs.readFileSync(PROXY_FILE, 'utf8');
            proxies = data.split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));

            if (proxies.length > 0) {
                logger.info(`Loaded ${proxies.length} proxies from ${PROXY_FILE}`);
            } else {
                logger.warn(`No proxies found in ${PROXY_FILE}. Operations will proceed without proxies.`);
            }
        } else {
            logger.warn(`Proxy file ${PROXY_FILE} not found. Operations will proceed without proxies.`);
        }
    } catch (error) {
        logger.error(`Failed to load proxies: ${error.message}`);
    }
}

function getNextProxy() {
    if (proxies.length === 0) return null;
    const proxy = proxies[currentProxyIndex];
    currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
    return proxy;
}

function extractProxyIP(proxy) {
    try {
        let cleanProxy = proxy.replace(/^https?:\/\//, '').replace(/.*@/, '');
        const ip = cleanProxy.split(':')[0];
        return ip || cleanProxy;
    } catch (error) {
        return proxy;
    }
}

function createAxiosInstance() {
    const config = {
        headers: {
            'User-Agent': getRandomUserAgent(),
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'en-US,en;q=0.8',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-site',
            'sec-gpc': '1',
            'Referer': 'https://storagescan-galileo.0g.ai/',
            'Referrer-Policy': 'strict-origin-when-cross-origin'
        }
    };

    const proxy = getNextProxy();
    if (proxy) {
        const proxyIP = extractProxyIP(proxy);
        logger.debug(`Using proxy IP: ${proxyIP}`);
        config.httpsAgent = new HttpsProxyAgent(proxy);
    }

    return axios.create(config);
}

function getRandomUserAgent() {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:124.0) Gecko/20100101 Firefox/124.0',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/122.0.6261.89 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36',
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.119 Mobile Safari/537.36'
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// --- Wallet Initialization ---
function initializeWallet() {
    const privateKey = getNextPrivateKey();
    return new ethers.Wallet(privateKey, provider);
}

// --- Network Checks ---
async function checkNetworkSync() {
    try {
        logger.loading('Checking network synchronization...');
        const blockNumber = await provider.getBlockNumber();
        logger.success(`Network synced at block ${blockNumber}`);
        return true;
    } catch (error) {
        logger.error(`Network sync check failed: ${error.message}`);
        return false;
    }
}

// --- Image & Hash Operations ---
async function fetchRandomImage() {
    try {
        logger.loading('Fetching random image from public source...');
        const axiosInstance = createAxiosInstance();
        const source = IMAGE_SOURCES[Math.floor(Math.random() * IMAGE_SOURCES.length)];
        const response = await axiosInstance.get(source.url, {
            responseType: source.responseType,
            maxRedirects: 5
        });
        logger.success('Image fetched successfully.');
        return response.data;
    } catch (error) {
        logger.error(`Error fetching image: ${error.message}`);
        throw error;
    }
}

async function checkFileExists(fileHash) {
    try {
        logger.loading(`Checking if file hash ${fileHash} already exists...`);
        const axiosInstance = createAxiosInstance();
        const response = await axiosInstance.get(`${INDEXER_URL}/file/info/${fileHash}`);
        return response.data.exists || false;
    } catch (error) {
        logger.warn(`Failed to check file hash. Assuming non-existent: ${error.message}`);
        return false;
    }
}

async function prepareImageData(imageBuffer) {
    const MAX_HASH_ATTEMPTS = 5;
    let attempt = 1;

    while (attempt <= MAX_HASH_ATTEMPTS) {
        try {
            const salt = crypto.randomBytes(16).toString('hex');
            const timestamp = Date.now().toString();
            const hashInput = Buffer.concat([
                Buffer.from(imageBuffer),
                Buffer.from(salt),
                Buffer.from(timestamp)
            ]);
            const hash = '0x' + crypto.createHash('sha256').update(hashInput).digest('hex');
            const fileExists = await checkFileExists(hash);
            if (fileExists) {
                logger.warn(`Hash ${hash} already exists, retrying unique hash generation (Attempt ${attempt}/${MAX_HASH_ATTEMPTS})...`);
                attempt++;
                continue;
            }
            const imageBase64 = Buffer.from(imageBuffer).toString('base64');
            logger.success(`Generated unique file hash: ${hash}`);
            return {
                root: hash,
                data: imageBase64
            };
        } catch (error) {
            logger.error(`Error generating hash (attempt ${attempt}): ${error.message}`);
            attempt++;
            if (attempt > MAX_HASH_ATTEMPTS) {
                throw new Error(`Failed to generate unique hash after ${MAX_HASH_ATTEMPTS} attempts`);
            }
        }
    }
}

// --- Storage Upload Operations ---
async function uploadToStorage(imageData, wallet, walletIndex) {
    const MAX_RETRIES = 3;
    const TIMEOUT_SECONDS = 300;
    let attempt = 1;

    logger.loading(`Checking wallet balance for ${wallet.address}...`);
    const balance = await provider.getBalance(wallet.address);
    const minBalance = parseEther('0.0015'); // Adjusted for safety
    if (BigInt(balance) < BigInt(minBalance)) {
        throw new Error(`Insufficient balance: ${formatEther(balance)} OG. Minimum required: ${formatEther(minBalance)} OG`);
    }
    logger.success(`Wallet balance: ${formatEther(balance)} OG`);

    while (attempt <= MAX_RETRIES) {
        try {
            logger.loading(`Uploading file segment for wallet #${walletIndex + 1} [${wallet.address}] (Attempt ${attempt}/${MAX_RETRIES})...`);
            const axiosInstance = createAxiosInstance();
            await axiosInstance.post(`${INDEXER_URL}/file/segment`, {
                root: imageData.root,
                index: 0,
                data: imageData.data,
                proof: {
                    siblings: [imageData.root],
                    path: []
                }
            }, {
                headers: {
                    'content-type': 'application/json'
                },
                timeout: 60 * 1000 // 60 seconds timeout for segment upload
            });
            logger.success('File segment uploaded to indexer.');

            const contentHash = crypto.randomBytes(32); // Random hash for the call data
            const data = ethers.concat([
                Buffer.from(METHOD_ID.slice(2), 'hex'),
                Buffer.from('0000000000000000000000000000000000000000000000000000000000000020', 'hex'),
                Buffer.from('0000000000000000000000000000000000000000000000000000000000000014', 'hex'),
                Buffer.from('0000000000000000000000000000000000000000000000000000000000000060', 'hex'),
                Buffer.from('0000000000000000000000000000000000000000000000000000000000000080', 'hex'),
                Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex'),
                Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex'),
                contentHash,
                Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex')
            ]);

            const value = parseEther('0.000839233398436224'); // Value sent with the transaction
            const gasPrice = parseUnits('1.029599997', 'gwei'); // Base gas price

            logger.loading('Estimating gas limit for transaction...');
            let gasLimit;
            try {
                const gasEstimate = await provider.estimateGas({
                    to: CONTRACT_ADDRESS,
                    data,
                    from: wallet.address,
                    value
                });
                gasLimit = BigInt(gasEstimate) * 15n / 10n; // Add 50% buffer
                logger.success(`Gas limit estimated: ${gasLimit.toString()}`);
            } catch (error) {
                gasLimit = 300000n; // Default fallback gas limit
                logger.warn(`Gas estimation failed (${error.message}), using default gas limit: ${gasLimit.toString()}`);
            }

            const gasCost = BigInt(gasPrice) * gasLimit;
            const requiredBalance = gasCost + BigInt(value);
            if (BigInt(balance) < requiredBalance) {
                throw new Error(`Insufficient balance for transaction. Needed: ${formatEther(requiredBalance)} OG, Has: ${formatEther(balance)} OG`);
            }

            logger.loading('Sending transaction to blockchain...');
            const nonce = await provider.getTransactionCount(wallet.address, 'latest');
            const txParams = {
                to: CONTRACT_ADDRESS,
                data,
                value,
                nonce,
                chainId: CHAIN_ID,
                gasPrice,
                gasLimit
            };

            const tx = await wallet.sendTransaction(txParams);
            const txLink = `${EXPLORER_URL}${tx.hash}`;
            logger.info(`Transaction sent: ${tx.hash}`);
            logger.info(`Explorer Link: {underline}${txLink}{/underline}`); // Added underline tag

            logger.loading(`Waiting for transaction confirmation (up to ${TIMEOUT_SECONDS}s)...`);
            let receipt;
            try {
                receipt = await Promise.race([
                    tx.wait(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error(`Transaction confirmation timeout after ${TIMEOUT_SECONDS} seconds`)), TIMEOUT_SECONDS * 1000))
                ]);
            } catch (error) {
                if (error.message.includes('Timeout')) {
                    logger.warn(`Transaction timed out. Checking for late confirmation.`);
                    receipt = await provider.getTransactionReceipt(tx.hash);
                    if (receipt && receipt.status === 1) {
                        logger.success(`Transaction confirmed late in block ${receipt.blockNumber}.`);
                    } else {
                        throw new Error(`Transaction failed or remains pending after timeout: ${txLink}`);
                    }
                } else {
                    throw error;
                }
            }

            if (receipt.status === 1) {
                logger.success(`Transaction successfully confirmed in block ${receipt.blockNumber}.`);
                logger.success(`File uploaded, root hash: ${imageData.root}`);
                return receipt;
            } else {
                throw new Error(`Transaction failed on-chain: ${txLink}`);
            }
        } catch (error) {
            logger.error(`Upload attempt ${attempt} failed: ${error.message}`);
            if (attempt < MAX_RETRIES) {
                const delay = 10 + Math.random() * 20; // Random delay between 10-30 seconds
                logger.warn(`Retrying in ${delay.toFixed(1)}s...`);
                await new Promise(resolve => setTimeout(resolve, delay * 1000));
                attempt++;
                continue;
            }
            throw error; // Propagate error if all retries fail
        }
    }
}

// --- Main Task Logic ---
async function startAutoTask() {
    if (privateKeys.length === 0) {
        logger.critical('No wallets loaded. Please refresh configuration first.');
        return;
    }
    setGeneralStatus('Active');
    logger.section('Starting Auto Task');

    const totalUploads = uploadCountPerWallet * privateKeys.length;
    logger.info(`Initiating ${totalUploads} uploads across ${privateKeys.length} wallet(s) (${uploadCountPerWallet} uploads per wallet).`);

    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    let successful = 0;
    let failed = 0;

    for (let walletIndex = 0; walletIndex < privateKeys.length; walletIndex++) {
        currentKeyIndex = walletIndex; // Set the current key index for the wallet rotation
        const wallet = initializeWallet();
        setGeneralStatus('Active', wallet.address, totalAccounts);
        logger.section(`Processing Wallet #${walletIndex + 1} [${wallet.address}]`);

        for (let i = 1; i <= uploadCountPerWallet; i++) {
            const uploadNumber = (walletIndex * uploadCountPerWallet) + i;
            logger.process(`Upload ${uploadNumber}/${totalUploads} (Wallet #${walletIndex + 1}, File #${i})`);

            try {
                const imageBuffer = await fetchRandomImage();
                const imageData = await prepareImageData(imageBuffer);
                await uploadToStorage(imageData, wallet, walletIndex);
                successful++;
                logger.success(`Upload ${uploadNumber} completed successfully!`);

                if (uploadNumber < totalUploads) {
                    const interUploadDelay = 5 + Math.random() * 10; // 5-15 seconds
                    logger.loading(`Waiting for ${interUploadDelay.toFixed(1)}s before next upload...`);
                    await delay(interUploadDelay * 1000);
                }
            } catch (error) {
                failed++;
                logger.error(`Upload ${uploadNumber} failed: ${error.message}`);
                const errorDelay = 10 + Math.random() * 20; // 10-30 seconds on error
                logger.warn(`Pausing for ${errorDelay.toFixed(1)}s due to error...`);
                await delay(errorDelay * 1000);
            }
        }

        if (walletIndex < privateKeys.length - 1) {
            const walletSwitchDelay = 30 + Math.random() * 30; // 30-60 seconds between wallets
            logger.loading(`Switching to next wallet in ${walletSwitchDelay.toFixed(1)}s...`);
            await delay(walletSwitchDelay * 1000);
        }
    }

    logger.section('Upload Summary');
    logger.summary(`Total Wallets Processed: ${privateKeys.length}`);
    logger.summary(`Uploads Attempted per Wallet: ${uploadCountPerWallet}`);
    logger.summary(`Total Uploads Attempted: ${totalUploads}`);
    if (successful > 0) logger.success(`Successful Uploads: ${successful}`);
    if (failed > 0) logger.error(`Failed Uploads: ${failed}`);
    logger.success('All planned operations completed.');
    setGeneralStatus('Idle', activeAccountAddress, totalAccounts); // Reset status
    updateWalletInfo(); // Refresh balances after task
}

// --- TUI Setup ---
function initializeTUI() {
    screen = blessed.screen({
        smartCSR: true,
        title: '0G Storage Scan Auto Bot',
        dockBorders: true,
        terminal: 'xterm-256color', // Ensure proper colors
    });

    // Handle screen resizing
    screen.on('resize', function() {
        screen.render();
    });

    // Quit on C-c
    screen.key(['C-c'], function(ch, key) {
        logger.bye('Exiting application...');
        return process.exit(0);
    });

    // Generate the new banner content
    const bannerText = 'EARNINGDROP';
    const telegramText = '- Telegram Channel: EARNINGDROP | Link: https://t.me/earningdropshub -';
    const botDescriptionText = 'OGLABS AUTOMATED BOT DESIGNED FOR DAILY IMAGE UPLOAD';

    const figletBanner = figlet.textSync(bannerText, { font: "ANSI Shadow", horizontalLayout: 'full' });

    // Construct the banner content using Blessed.js tags
    const logoContent = `
${figletBanner.split('\n').map(line => `{center}{cyan-fg}{bold}${line}{/bold}{/cyan-fg}`).join('\n')}
{center}{white-fg}${telegramText}{/white-fg}
{center}{white-fg}${botDescriptionText}{/white-fg}
    `;

    // Top Header / Logo
    blessed.box({
        parent: screen,
        top: 0,
        left: 'center',
        width: '100%', // Fixed width to 100% as requested
        height: 12, // Increased height to accommodate the new logo
        content: logoContent,
        tags: true,
        border: 'line',
        style: {
            border: { fg: 'blue' },
            bg: 'black'
        }
    });

    // Status Box - Adjusted top position
    statusBox = blessed.box({
        parent: screen,
        top: 12, // Below new logo (previous 6 + 6 height = 12)
        left: 0,
        width: '100%',
        height: 3,
        tags: true,
        border: 'line',
        label: '{bold}Status{/bold}',
        style: {
            border: { fg: 'blue' },
            label: { fg: 'white', bold: true },
            bg: 'black'
        },
        content: '' // Content set by updateStatusDisplay
    });

    // Wallet Information Box - Adjusted top position
    walletBox = blessed.box({
        parent: screen,
        top: 15, // Below status box (12 + 3 = 15)
        left: 0,
        width: '100%', // Full width
        height: 10, // Reduced height from 12 to 10
        tags: true,
        scrollable: true,
        alwaysScroll: true,
        scrollbar: {
            ch: ' ',
            inverse: true
        },
        border: 'line',
        label: '{bold}Wallet Information{/bold}',
        style: {
            border: { fg: 'magenta' },
            label: { fg: 'white', bold: true },
            bg: 'black'
        }
    });

    // Menu Box - Left side - Adjusted top position
    menuBox = blessed.list({
        parent: screen,
        top: 25, // Adjusted top: 15 (prev top) + 10 (new height) = 25
        left: 0,
        width: '50%', // Left half
        height: '100%-25', // Remaining height
        tags: true,
        keys: true,
        mouse: true,
        vi: true,
        label: '{bold}Menu{/bold}',
        border: 'line',
        style: {
            item: {
                hover: { bg: 'blue' }
            },
            selected: {
                bg: 'magenta',
                fg: 'white',
                bold: true
            },
            border: { fg: 'red' },
            label: { fg: 'white', bold: true },
            bg: 'black'
        },
        items: [
            '1. Start Auto Task',
            '2. Set Upload Count',
            '3. Refresh Wallet Data',
            '4. Clear Logs',
            '5. Exit'
        ]
    });

    // Transaction Logs Box - Right side - Adjusted top position
    logBox = blessed.log({
        parent: screen,
        top: 25, // Adjusted top to match menu box
        left: '50%', // Right half
        width: '50%', // Right half
        height: '100%-25', // Remaining height
        tags: true, // Crucial for Blessed.js tag parsing
        scrollable: true,
        alwaysScroll: true,
        scrollbar: {
            ch: ' ',
            inverse: true
        },
        border: 'line',
        label: '{bold}Transaction Logs{/bold}',
        style: {
            border: { fg: 'cyan' },
            label: { fg: 'white', bold: true },
            bg: 'black'
        }
    });

    menuBox.on('select', async function(item, index) {
        switch (index) {
            case 0: // Start Auto Task
                if (currentStatus === 'Active') {
                    logger.warn('Auto task is already running.');
                    break;
                }
                menuBox.focus(); // Keep focus on menu
                await startAutoTask();
                menuBox.focus(); // Re-focus after task
                break;
            case 1: // Set Upload Count
                blessed.prompt({
                    parent: screen,
                    top: 'center',
                    left: 'center',
                    height: 9,
                    width: '50%',
                    border: 'line',
                    label: '{bold}Set Upload Count{/bold}',
                    style: {
                        bg: 'gray',
                        fg: 'white',
                        border: { fg: 'white' },
                        label: { fg: 'black', bold: true }
                    },
                    content: 'Enter number of images to upload per wallet:',
                }).input('1', (err, value) => {
                    if (err) {
                        logger.error(`Error during input: ${err.message}`);
                    } else if (value) {
                        const newCount = parseInt(value);
                        if (!isNaN(newCount) && newCount > 0) {
                            uploadCountPerWallet = newCount;
                            logger.info(`Upload count set to ${uploadCountPerWallet} images per wallet.`);
                            // No need to update status bar for this, as it's removed
                        } else {
                            logger.error('Invalid input. Please enter a positive number.');
                        }
                    }
                    screen.render();
                    menuBox.focus(); // Return focus to menu
                });
                break;
            case 2: // Refresh Wallet Data
                logger.info('Refreshing wallet data...');
                loadPrivateKeys(); // This also updates wallet info and triggers status update
                loadProxies(); // Refresh proxies
                logger.success('Wallet data and proxies refreshed.');
                menuBox.focus(); // Return focus to menu
                break;
            case 3: // Clear Logs
                logger.clear();
                menuBox.focus(); // Return focus to menu
                break;
            case 4: // Exit
                logger.bye('Exiting application...');
                process.exit(0);
                break;
        }
        screen.render();
    });

    // Set initial focus
    menuBox.focus();

    // Initial loads and updates
    logger.banner(); // Display initial banner message
    loadPrivateKeys();
    loadProxies();
    updateStatusDisplay();
    updateWalletInfo(); // Initial update of wallet info

    screen.render();
}

// Start the TUI
initializeTUI();
