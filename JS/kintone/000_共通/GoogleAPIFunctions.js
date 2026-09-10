/**
 * Google API関連の関数群
 */
// NEED: config.js

async function fetchWithRetryOnce(url, options) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok || attempt === 2) {
        return response;
      }
    } catch (error) {
      if (attempt === 2) {
        throw error;
      }
    }
  }
}

// アクセストークンの取得
async function getAccessToken() {
  const response = await fetchWithRetryOnce('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: currentConfig.google.api.client_id,
      client_secret: currentConfig.google.api.secret,
      refresh_token: currentConfig.google.api.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error('Token Error: ' + data.error_description);
  return data.access_token;
}

// Google Driveにフォルダを作成
async function createDriveFolder(accessToken, parentFolderId, folderName) {
  const existingFolder = await findDriveFolder(accessToken, parentFolderId, folderName);
  if (existingFolder) {
    return existingFolder;
  }

  const payload = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder'
  };
  if (parentFolderId) payload.parents = [parentFolderId];

  const response = await fetchWithRetryOnce('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink,parents,mimeType', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data && data.error && data.error.message
      ? data.error.message
      : JSON.stringify(data);
    throw new Error('Drive Folder Create Error: ' + message);
  }
  return data;
}

async function findDriveFolder(accessToken, parentFolderId, folderName) {
  if (!folderName) {
    throw new Error('Folder name is required.');
  }

  const queryParts = [
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
    `name = '${String(folderName).replace(/'/g, "\\'")}'`
  ];

  if (parentFolderId) {
    queryParts.push(`'${String(parentFolderId).replace(/'/g, "\\'")}' in parents`);
  }

  const params = new URLSearchParams({
    q: queryParts.join(' and '),
    fields: 'files(id,name,webViewLink,parents,mimeType)',
    pageSize: '1',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
  });

  const response = await fetchWithRetryOnce(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data && data.error && data.error.message
      ? data.error.message
      : JSON.stringify(data);
    throw new Error('Drive Folder Search Error: ' + message);
  }

  return Array.isArray(data.files) && data.files.length > 0 ? data.files[0] : null;
}

// Google Driveのファイルをコピー（targetMimeType指定時は変換コピー）
async function copyDriveFile(accessToken, fileId, newName, parentFolderId, targetMimeType = '') {
  const existingFile = await findDriveFile(accessToken, parentFolderId, newName);
  if (existingFile) {
    await deleteDriveItem(accessToken, existingFile.id);
  }

  const payload = {
    name: newName
  };
  if (parentFolderId) payload.parents = [parentFolderId];
  if (targetMimeType) payload.mimeType = targetMimeType;

  const response = await fetchWithRetryOnce(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/copy?fields=id,name,webViewLink,parents,mimeType`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data && data.error && data.error.message
      ? data.error.message
      : JSON.stringify(data);
    throw new Error('Drive File Copy Error: ' + message);
  }
  return data;
}

async function findDriveFile(accessToken, parentFolderId, fileName) {
  if (!fileName) {
    throw new Error('File name is required.');
  }

  const queryParts = [
    "mimeType != 'application/vnd.google-apps.folder'",
    'trashed = false',
    `name = '${String(fileName).replace(/'/g, "\\'")}'`
  ];

  if (parentFolderId) {
    queryParts.push(`'${String(parentFolderId).replace(/'/g, "\\'")}' in parents`);
  }

  const params = new URLSearchParams({
    q: queryParts.join(' and '),
    fields: 'files(id,name,webViewLink,parents,mimeType)',
    pageSize: '1',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
  });

  const response = await fetchWithRetryOnce(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const data = await response.json();
  if (!response.ok) {
    const message = data && data.error && data.error.message
      ? data.error.message
      : JSON.stringify(data);
    throw new Error('Drive File Search Error: ' + message);
  }

  return Array.isArray(data.files) && data.files.length > 0 ? data.files[0] : null;
}

async function deleteDriveItem(accessToken, fileId) {
  if (!fileId) {
    throw new Error('File ID is required.');
  }

  const params = new URLSearchParams({
    supportsAllDrives: 'true'
  });

  const response = await fetchWithRetryOnce(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error('Drive Item Delete Error: ' + errorText);
  }
}

// Google Sheetsの値更新（A1記法のセル範囲・名前付き範囲のどちらも指定可能）
async function updateSpreadsheetValues(accessToken, spreadsheetId, range, values, options = {}) {
  if (!spreadsheetId) {
    throw new Error('Spreadsheet ID is required.');
  }
  if (!range) {
    throw new Error('Range is required.');
  }
  if (!Array.isArray(values)) {
    throw new Error('Values must be a 2D array.');
  }
  
  const targetRange = resolveSpreadsheetRange(range, options.sheetName);
  const valueInputOption = options.valueInputOption || 'RAW';
  const majorDimension = options.majorDimension || 'ROWS';
  const body = {
    range: targetRange,
    majorDimension,
    values
  };

  const params = new URLSearchParams({
    valueInputOption
  });

  const response = await fetchWithRetryOnce(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(targetRange)}?${params.toString()}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();
  if (!response.ok) {
    const message = data && data.error && data.error.message
      ? data.error.message
      : JSON.stringify(data);
    throw new Error('Spreadsheet Update Error: ' + message);
  }
  return data;
}

// Google Sheetsの1セルの値を取得（シート名とA1形式のセルを指定）
async function getSpreadsheetValue(accessToken, spreadsheetId, sheetName, cellReference, options = {}) {
  if (!spreadsheetId) {
    throw new Error('Spreadsheet ID is required.');
  }
  if (!sheetName) {
    throw new Error('Sheet name is required.');
  }
  if (!cellReference) {
    throw new Error('Cell reference is required.');
  }
  if (!isA1NotationRange(cellReference) || String(cellReference).includes(':')) {
    throw new Error('Cell reference must be a single A1 notation cell (e.g. A1).');
  }

  const targetRange = resolveSpreadsheetRange(cellReference, sheetName);
  const valueRenderOption = options.valueRenderOption || 'FORMATTED_VALUE';
  const dateTimeRenderOption = options.dateTimeRenderOption || 'FORMATTED_STRING';
  const params = new URLSearchParams({
    valueRenderOption,
    dateTimeRenderOption
  });

  const response = await fetchWithRetryOnce(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(targetRange)}?${params.toString()}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  const data = await response.json();
  if (!response.ok) {
    const message = data && data.error && data.error.message
      ? data.error.message
      : JSON.stringify(data);
    throw new Error('Spreadsheet Get Value Error: ' + message);
  }

  return data && Array.isArray(data.values) && Array.isArray(data.values[0])
    ? data.values[0][0]
    : '';
}

function resolveSpreadsheetRange(range, sheetName) {
  if (!sheetName || range.includes('!') || !isA1NotationRange(range)) {
    return range;
  }

  const escapedSheetName = String(sheetName).replace(/'/g, "''");
  return `'${escapedSheetName}'!${range}`;
}

function isA1NotationRange(range) {
  return /^[A-Za-z]+\d+(?::[A-Za-z]+\d+)?$/.test(String(range));
}

/**
 * Google Spreadsheetに定義されているすべての名前付き範囲を取得する
 * @param {string} accessToken
 * @param {string} spreadsheetId
 * @returns {Promise<Array<{
 *   name: string,
 *   sheetId: number,
 *   sheetName: string,
 *   startRow: number,
 *   startColumn: number,
 *   endRow: number,
 *   endColumn: number,
 *   a1Notation: string,
 *   r1c1Notation: string
 * }>>}
 */
async function getSpreadsheetNamedRanges(accessToken, spreadsheetId) {
  if (!spreadsheetId) {
    throw new Error('Spreadsheet ID is required.');
  }

  const fields = 'namedRanges(name,range(sheetId,startRowIndex,startColumnIndex,endRowIndex,endColumnIndex)),sheets(properties(sheetId,title))';
  const response = await fetchWithRetryOnce(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  const data = await response.json();
  if (!response.ok) {
    const message = data && data.error && data.error.message
      ? data.error.message
      : JSON.stringify(data);
    throw new Error('Get Named Ranges Error: ' + message);
  }

  const sheetMap = {};
  for (const sheet of (data.sheets || [])) {
    if (sheet.properties) {
      sheetMap[sheet.properties.sheetId] = sheet.properties.title;
    }
  }

  return (data.namedRanges || []).map(item => {
    const g = item.range || {};
    // Sheets API: startRowIndex/startColumnIndex は 0-indexed inclusive
    //             endRowIndex/endColumnIndex は 0-indexed exclusive
    const startRow = Number(g.startRowIndex || 0) + 1;
    const startColumn = Number(g.startColumnIndex || 0) + 1;
    const endRow = Number(g.endRowIndex || g.startRowIndex || 0);       // exclusive → そのまま1-indexed end
    const endColumn = Number(g.endColumnIndex || g.startColumnIndex || 0);
    const sheetName = sheetMap[g.sheetId] || '';
    const escapedSheetName = sheetName ? `'${sheetName.replace(/'/g, "''")}'!` : '';

    const startA1 = `${columnIndexToLabel(startColumn)}${startRow}`;
    const endA1 = `${columnIndexToLabel(endColumn)}${endRow}`;
    const isSingleCell = startRow === endRow && startColumn === endColumn;

    const rangeA1 = isSingleCell ? startA1 : `${startA1}:${endA1}`;
    const rangeR1C1 = isSingleCell
      ? `R${startRow}C${startColumn}`
      : `R${startRow}C${startColumn}:R${endRow}C${endColumn}`;

    return {
      name: item.name,
      sheetId: g.sheetId,
      sheetName,
      startRow,
      startColumn,
      endRow,
      endColumn,
      a1Notation: `${escapedSheetName}${rangeA1}`,
      r1c1Notation: `${escapedSheetName}${rangeR1C1}`
    };
  });
}

// Google Spreadsheetの名前付きセル(名前付き範囲)の先頭位置を取得
async function getNamedCellPosition(accessToken, spreadsheetId, namedRangeName, offset = {x: 0, y: 0}) {
  if (!spreadsheetId) {
    throw new Error('Spreadsheet ID is required.');
  }
  if (!namedRangeName) {
    throw new Error('Named range name is required.');
  }

  const fields = 'namedRanges(name,range(sheetId,startRowIndex,startColumnIndex)),sheets(properties(sheetId,title))';
  const response = await fetchWithRetryOnce(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  const data = await response.json();
  if (!response.ok) {
    const message = data && data.error && data.error.message
      ? data.error.message
      : JSON.stringify(data);
    throw new Error('Get Named Range Error: ' + message);
  }

  const namedRange = (data.namedRanges || []).find(item => item.name === namedRangeName);
  if (!namedRange || !namedRange.range) {
    throw new Error(`Named range not found: ${namedRangeName}`);
  }

  const gridRange = namedRange.range;
  const row = Number(gridRange.startRowIndex || 0) + 1;
  const column = Number(gridRange.startColumnIndex || 0) + 1;
  const sheet = (data.sheets || []).find(s => s.properties && s.properties.sheetId === gridRange.sheetId);
  const sheetName = sheet && sheet.properties ? sheet.properties.title : '';

  return getNamedCellPositionByOffset(
    {
    name: namedRangeName,
    sheetId: gridRange.sheetId,
    sheetName,
    startRow,
    startColumn,
    a1Notation: `${columnIndexToLabel(column)}${row}`
    },
    offset
  );
}

function getNamedCellPositionByOffset(baseCellPosition, offset = {x: 0, y: 0}) {
  const offsetX = Number(offset.x || 0);
  const offsetY = Number(offset.y || 0);
  const row = Number(baseCellPosition.startRow) + offsetY;
  const column = Number(baseCellPosition.startColumn) + offsetX;

  if (!Number.isFinite(row) || !Number.isFinite(column) || row <= 0 || column <= 0) {
    throw new Error('Invalid offset result. Row/column must be positive numbers.');
  }

  return {
    ...baseCellPosition,
    row,
    column,
    a1Notation: `${columnIndexToLabel(column)}${row}`
  };
}

function columnIndexToLabel(columnIndex) {
  let value = Number(columnIndex);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Column index must be a positive number.');
  }

  let label = '';
  while (value > 0) {
    const mod = (value - 1) % 26;
    label = String.fromCharCode(65 + mod) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function columnLabelToIndex(columnLabel) {
  const normalized = String(columnLabel || '').trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) {
    throw new Error('Column label must contain only alphabet letters.');
  }

  let index = 0;
  for (const char of normalized) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index;
}

function parseA1StartCell(cellReference) {
  const input = String(cellReference || '').trim();
  if (!input) {
    throw new Error('Start cell reference is required.');
  }

  const withSheet = input.match(/^(?:'((?:[^']|'')+)'|([^!]+))!([A-Za-z]+)(\d+)$/);
  if (withSheet) {
    const rawSheetName = withSheet[1] !== undefined ? withSheet[1] : withSheet[2];
    return {
      sheetName: String(rawSheetName).replace(/''/g, "'"),
      column: columnLabelToIndex(withSheet[3]),
      row: Number(withSheet[4])
    };
  }

  const noSheet = input.match(/^([A-Za-z]+)(\d+)$/);
  if (noSheet) {
    return {
      sheetName: '',
      column: columnLabelToIndex(noSheet[1]),
      row: Number(noSheet[2])
    };
  }

  throw new Error('Start cell must be a single A1 notation cell (e.g. A1 or "Sheet1!B2").');
}

// 開始セルと行オフセットを指定して、1行分の配列をSpreadsheetへ書き込む
async function writeRowAtStartCellOffset(accessToken, spreadsheetId, startCell, rowOffset, rowValues, options = {}) {
  if (!startCell || !startCell.row || !startCell.column) {
    throw new Error('Start cell position is required.');
  }
  if (!Array.isArray(rowValues) || rowValues.length === 0) {
    throw new Error('Row values must be a non-empty array.');
  }

  const rowNumber = Number(startCell.row) + Number(rowOffset || 0);
  const startColumn = Number(startCell.column);
  const endColumn = startColumn + rowValues.length - 1;
  const range = `${columnIndexToLabel(startColumn)}${rowNumber}:${columnIndexToLabel(endColumn)}${rowNumber}`;

  return await updateSpreadsheetValues(
    accessToken,
    spreadsheetId,
    range,
    [rowValues],
    {
      sheetName: options.sheetName || startCell.sheetName || '',
      valueInputOption: options.valueInputOption || 'USER_ENTERED',
      majorDimension: options.majorDimension || 'ROWS'
    }
  );
}

// 開始セルとオフセットを指定して、2次元配列を行列を崩さずSpreadsheetへ書き込む
async function writeMatrixAtStartCellOffset(accessToken, spreadsheetId, startPosition, offset = {x: 0, y: 0}, matrixValues = [], options = {}) {
  if (!spreadsheetId) {
    throw new Error('Spreadsheet ID is required.');
  }
  if (!Array.isArray(matrixValues) || matrixValues.length === 0) {
    throw new Error('Matrix values must be a non-empty 2D array.');
  }

  const firstRow = matrixValues[0];
  const isArrayRows = Array.isArray(firstRow);
  const isObjectRows = firstRow !== null && typeof firstRow === 'object' && !Array.isArray(firstRow);
  if (!isArrayRows && !isObjectRows) {
    throw new Error('Each row in matrix values must be an array or object.');
  }

  let normalizedValues = [];
  let columnCount = 0;
  if (isArrayRows) {
    if (firstRow.length === 0) {
      throw new Error('Matrix values must include at least one column.');
    }
    columnCount = firstRow.length;
    for (const row of matrixValues) {
      if (!Array.isArray(row)) {
        throw new Error('All rows in matrix values must be arrays when first row is an array.');
      }
      if (row.length !== columnCount) {
        throw new Error('All rows in matrix values must have the same number of columns.');
      }
    }
    normalizedValues = matrixValues;
  } else {
    const columnKeys = Array.isArray(options.columnKeys) && options.columnKeys.length > 0
      ? options.columnKeys.map((key) => String(key))
      : Object.keys(firstRow);

    if (columnKeys.length === 0) {
      throw new Error('Object rows must include at least one key, or options.columnKeys must be provided.');
    }

    columnCount = columnKeys.length;
    normalizedValues = matrixValues.map((row) => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error('All rows in matrix values must be objects when first row is an object.');
      }
      return columnKeys.map((key) => row[key] !== undefined ? row[key] : '');
    });
  }

  const baseCell = typeof startPosition === 'string'
    ? parseA1StartCell(startPosition)
    : {
      row: Number(startPosition && startPosition.row),
      column: Number(startPosition && startPosition.column),
      sheetName: String((startPosition && startPosition.sheetName) || '')
    };

  if (!Number.isFinite(baseCell.row) || !Number.isFinite(baseCell.column) || baseCell.row <= 0 || baseCell.column <= 0) {
    throw new Error('Start position row/column must be positive numbers.');
  }

  const offsetX = Number(offset && offset.x || 0);
  const offsetY = Number(offset && offset.y || 0);
  const startRow = baseCell.row + offsetY;
  const startColumn = baseCell.column + offsetX;
  const endRow = startRow + matrixValues.length - 1;
  const endColumn = startColumn + columnCount - 1;

  if (!Number.isFinite(startRow) || !Number.isFinite(startColumn) || startRow <= 0 || startColumn <= 0) {
    throw new Error('Invalid offset result. Row/column must be positive numbers.');
  }

  const range = `${columnIndexToLabel(startColumn)}${startRow}:${columnIndexToLabel(endColumn)}${endRow}`;
  return await updateSpreadsheetValues(
    accessToken,
    spreadsheetId,
    range,
    normalizedValues,
    {
      sheetName: options.sheetName || baseCell.sheetName || '',
      valueInputOption: options.valueInputOption || 'USER_ENTERED',
      majorDimension: options.majorDimension || 'ROWS'
    }
  );
}

// Google Spreadsheetをxlsxとしてエクスポート
async function exportSpreadsheetAsXlsx(accessToken, spreadsheetId) {
  if (!spreadsheetId) {
    throw new Error('Spreadsheet ID is required.');
  }

  const exportMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const response = await fetchWithRetryOnce(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}/export?mimeType=${encodeURIComponent(exportMimeType)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error('Spreadsheet Export Error: ' + errorText);
  }
  return await response.blob();
}
