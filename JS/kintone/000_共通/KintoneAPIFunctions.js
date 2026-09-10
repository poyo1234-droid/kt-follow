/**
 * Kintone API関連の関数群
 */
// NEED: config.js

/**
 * 指定したアプリIDとビューIDに基づいて、Kintone REST APIを使用してレコードを取得する関数
 * @param {apiToken} apiToken - アプリ毎のKintone REST APIのAPIトークン
 * @param {number} appId - レコードを取得するアプリのID
 * @param {string} [viewId] - レコードを取得するビューのID（未指定時は最初のビューを対象）
 * @returns {Promise<Array>} - 取得したレコードの配列
 * @throws {Error} - ビューが見つからない場合やAPI呼び出しに失敗した場合にエラーをスロー
 */
async function fetchRecordsFromApp(apiToken, appId, viewId, appendCondition = '') {
  const client = new KintoneRestAPIClient({
    auth: {
      apiToken: apiToken
    }
  });
  const appViews = await client.app.getViews({app: appId});
  const views = Object.values(appViews.views);
  const targetView = viewId === undefined
    ? views.find(view => view.index === "0") // viewIdが指定されていない場合は最初のビューを使用
    : views.find(view => view.id === viewId);

  if (!views.length) {
    // throw new Error(`No views found in app ${appId}`);
    return await client.record.getAllRecords({app: appId}); // ビューが存在しない場合は全レコードを取得
  }
  if (!targetView) {
    throw new Error(`View with ID ${viewId} not found in app ${appId}`);
  }
  return await client.record.getAllRecords({app: appId, condition: targetView.filterCond + `${appendCondition}`, sort: targetView.sort});
}

/**
 * 現在表示されているアプリのレコードを取得する
 */
async function fetchRecords() {
  const appId = kintone.app.getId();
  const client = new KintoneRestAPIClient();
  const records = await client.record.getAllRecords({ app: appId });
  return records;
}

/**
 * アプリのレコード追加
 */
async function addAppRecord(requestBody) {
  try {
    const resp = await kintone.api(kintone.api.url('/k/v1/record.json', true), 'POST', requestBody);
    console.log('レコードの追加に成功しました。レコードID: ' + resp.id);
    return resp;
  } catch (error) {
    console.error('レコードの追加に失敗しました。', error);
    throw error;
  }
}

// KintoneにファイルアップロードしてfileKeyを返す
async function uploadFileToKintone(fileBlob, fileName) {
  if (!fileBlob) {
    throw new Error('File blob is required.');
  }

  const formData = new FormData();
  formData.append('__REQUEST_TOKEN__', kintone.getRequestToken());
  formData.append('file', fileBlob, fileName || `export_${Date.now()}.xlsx`);

  try {
    const response = await fetch(kintone.api.url('/k/v1/file.json', true), {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: formData,
      credentials: 'same-origin'
    });
    const data = await response.json();
    if (!response.ok) {
      const message = data && data.message ? data.message : JSON.stringify(data);
      throw new Error(message);
    }
    if (!data || !data.fileKey) {
      throw new Error('fileKey was not returned.');
    }
    return data.fileKey;
  } catch (error) {
    const message = error && error.message ? error.message : JSON.stringify(error);
    throw new Error('Kintone File Upload Error: ' + message);
  }
}
