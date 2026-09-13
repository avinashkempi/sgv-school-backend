const { google } = require('googleapis');
const logger = require('../utils/logger');

/**
 * Google Sheets Service
 * 
 * Fetches data from a Google Sheet using a service account.
 * Returns rows in the same format as csv-parser (keyed by header names),
 * so the data is directly compatible with importService.processImport().
 */

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const TAB_NAME = process.env.GOOGLE_SHEETS_TAB_NAME || 'students';

/**
 * Creates an authenticated Google Sheets API client using service account credentials.
 */
function getAuthClient() {
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

    if (!email || !privateKey) {
        throw new Error(
            'Google Sheets credentials not configured. ' +
            'Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY env vars.'
        );
    }

    // Handle quotes and escaped newlines from environment variables
    let formattedKey = privateKey;
    if (formattedKey.startsWith('"') && formattedKey.endsWith('"')) {
        formattedKey = formattedKey.slice(1, -1);
    }
    formattedKey = formattedKey.replace(/\\n/g, '\n');

    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: email,
            private_key: formattedKey
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });

    return auth;
}

/**
 * Fetches all rows from the configured Google Sheet tab.
 * Returns an array of objects keyed by header names (same format as csv-parser).
 * 
 * @param {Object} options
 * @param {string} [options.spreadsheetId] - Override spreadsheet ID
 * @param {string} [options.tabName] - Override tab name
 * @returns {Promise<Array<Object>>} Array of row objects
 */
async function fetchSheetData(options = {}) {
    const spreadsheetId = options.spreadsheetId || SPREADSHEET_ID;
    const tabName = options.tabName || TAB_NAME;

    if (!spreadsheetId) {
        throw new Error('GOOGLE_SHEETS_SPREADSHEET_ID is not configured.');
    }

    const auth = getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    logger.info(`[GoogleSheets] Fetching data from sheet "${tabName}" (ID: ${spreadsheetId})`);

    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${tabName}`,
    });

    const rows = response.data.values;

    if (!rows || rows.length < 2) {
        logger.warn('[GoogleSheets] Sheet is empty or has only headers');
        return [];
    }

    // First row is the header
    const headers = rows[0];
    const dataRows = rows.slice(1);

    // Convert each row into an object keyed by header names (same as csv-parser output)
    const result = dataRows.map((row, _index) => {
        const obj = {};
        headers.forEach((header, colIndex) => {
            // Use the raw header name as the key (csv-parser does the same)
            obj[header.trim()] = row[colIndex] !== undefined ? row[colIndex] : '';
        });
        return obj;
    });

    logger.info(`[GoogleSheets] Fetched ${result.length} data rows (${headers.length} columns)`);

    return result;
}

/**
 * Checks if Google Sheets sync is properly configured.
 * @returns {{ configured: boolean, reason?: string }}
 */
function isConfigured() {
    if (!SPREADSHEET_ID) {
        return { configured: false, reason: 'GOOGLE_SHEETS_SPREADSHEET_ID not set' };
    }
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
        return { configured: false, reason: 'GOOGLE_SERVICE_ACCOUNT_EMAIL not set' };
    }
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) {
        return { configured: false, reason: 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY not set' };
    }
    return { configured: true };
}

module.exports = { fetchSheetData, isConfigured };
