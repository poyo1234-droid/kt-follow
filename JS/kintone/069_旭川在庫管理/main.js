'use strict';
// NEED: config.js
// NEED: GoogleAPIFunctions.js
// NEED: KintoneAPIFunctions.js
// NEED: ui.js

/**
 * config選択
 */
const currentConfig = window.config.production;
// const currentConfig = window.config.development;

/**
 * 月次在庫報告ボタン設置
 */
setButton('outputSalesStatement', '月次在庫報告', outputMonthlyInventoryReport, false, 'index');

/**
 * 月次在庫報告の出力
 */
async function outputMonthlyInventoryReport(updateStatus) {
  
  // 現在のKintoneアプリ(旭川在庫管理)のレコードをKintone REST APIを使用して全レコード取得する
  updateStatus('旭川在庫管理全レコード取得中...');
  const records = await fetchRecords();
  console.log('旭川在庫管理全レコード:', records);
  
  // 旭川在庫管理のレコードをメーカー(名)、CS品番単位で集計する
  updateStatus('CS品番単位で集計中...');
  const aggregatedRecords = {};
  records.forEach(record => {
    const manufacturerName = record['メーカー'].value;
    const csNumber = record['CS品番'].value;
    // FIXME: CS品番が空文字のレコードは無視するようにする?
    if (!csNumber) {
      return;
    }
    if (!aggregatedRecords[manufacturerName]) {
      aggregatedRecords[manufacturerName] = {};
    }
    if (!aggregatedRecords[manufacturerName][csNumber]) {
      aggregatedRecords[manufacturerName][csNumber] = [record];
    } else {
      aggregatedRecords[manufacturerName][csNumber].push(record);
    }
  });
  console.log('メーカー名、CS品番単位で集計されたレコード:', aggregatedRecords);
  
  // 旭川在庫管理レコードのCS品番を元に、関連する商品マスタレコードを取得する
  updateStatus('商品マスタレコード取得中...');
  const csNumbers = [...new Set(records.map(record => record['CS品番'].value).filter(csNumber => csNumber))];
  const productMasterAppId = currentConfig.kintone.app['商品マスタ'].id;
  const productMasterApiToken = currentConfig.kintone.app['商品マスタ'].api_token;
  const productMasterViewId = currentConfig.kintone.app['商品マスタ'].view['販売中の商品'];
  const productMasterCondition = ` and CS別品番 in (` + csNumbers.map(csNumber => `"${csNumber}"`).join(', ') + `)`;
  const productMasterRecords = await fetchRecordsFromApp(productMasterApiToken, productMasterAppId, productMasterViewId, `${productMasterCondition}`);
  console.log('商品マスタレコード:', productMasterRecords);
  
  // 旭川在庫管理レコードのメーカーコードを元に、関連するメーカーマスタレコードを取得する
  updateStatus('メーカーマスタレコード取得中...');
  const manufacturerCodes = [...new Set(records.map(record => record['メーカーコード'].value).filter(manufacturerCode => manufacturerCode))];
  const manufacturerMasterAppId = currentConfig.kintone.app['メーカーマスタ from SQL'].id;
  const manufacturerMasterApiToken = currentConfig.kintone.app['メーカーマスタ from SQL'].api_token;
  const manufacturerMasterCondition = `メーカーID in (` + manufacturerCodes.map(manufacturerCode => `"${manufacturerCode}"`).join(', ') + `)`;
  const manufacturerMasterRecords = await fetchRecordsFromApp(manufacturerMasterApiToken, manufacturerMasterAppId, undefined, `${manufacturerMasterCondition}`);
  console.log('メーカーマスタレコード:', manufacturerMasterRecords);
  
  // 旭川在庫管理のレコードに足りないデータを補足する
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD形式
  Object.values(aggregatedRecords).forEach(recordsByManufacturer => {
    Object.values(recordsByManufacturer).forEach(recordsByCsNumber => {
      Object.values(recordsByCsNumber).forEach(record => {
        record['年月'] = {"type": "SINGLE_LINE_TEXT", "value": today.slice(0, -3).replace('-', '/')};
        const manufacturerMasterRecord = manufacturerMasterRecords.find(mRecord => mRecord['メーカーID'].value === record['メーカーコード'].value);
        let toName = [];
        let toMail = [];
        let ccName = [];
        let ccMail = [];
        let bccName = []; // FIXME: メーカーマスターにBCC項目ない
        let bccMail = []; // FIXME: メーカーマスターにBCC項目ない
        if (manufacturerMasterRecord?.['連絡先']?.value?.length > 0) {
          for (const contact of manufacturerMasterRecord['連絡先'].value.filter(item => item.value.宛先種別.value.includes("精算（TO）"))) {
            toName.push(contact.value['担当者名'].value);
            toMail.push(contact.value['メールアドレス'].value);
          }
          for (const contact of manufacturerMasterRecord['連絡先'].value.filter(item => item.value.宛先種別.value.includes("精算（CC）"))) {
            ccName.push(contact.value['担当者名'].value);
            ccMail.push(contact.value['メールアドレス'].value);
          }
          for (const contact of manufacturerMasterRecord['連絡先'].value.filter(item => item.value.宛先種別.value.includes("精算（BCC）"))) {
            bccName.push(contact.value['担当者名'].value);
            bccMail.push(contact.value['メールアドレス'].value);
          }
        }
        toName = toName.join(', ');
        toMail = toMail.join(', ');
        ccName = ccName.join(', ');
        ccMail = ccMail.join(', ');
        bccName = bccName.join(', ');
        bccMail = bccMail.join(', ');
        record['担当者名_TO'] = {"type": "SINGLE_LINE_TEXT", "value": toName}; 
        record['メール宛先_TO'] = {"type": "SINGLE_LINE_TEXT", "value": toMail}; 
        record['担当者名_CC'] = {"type": "SINGLE_LINE_TEXT", "value": ccName}; 
        record['メール宛先_CC'] = {"type": "SINGLE_LINE_TEXT", "value": ccMail}; 
        record['担当者名_BCC'] = {"type": "SINGLE_LINE_TEXT", "value": bccName}; 
        record['メール宛先_BCC'] = {"type": "SINGLE_LINE_TEXT", "value": bccMail}; 
      });
    });
  });
  console.log('補足された旭川在庫管理レコード:', aggregatedRecords);
  
  // Google API Access Tokenを取得する
  updateStatus('Googleアクセストークン取得中...');
  const accessToken = await getAccessToken();
  console.log('Googleアクセストークン:', accessToken);
  
  // YYYYMM形式のフォルダを作成する
  updateStatus('Google Driveフォルダ作成中...');
  const createdFolder = await createDriveFolder(accessToken, currentConfig.google.drive['旭川在庫管理'].target_folder_id, today.slice(0, -3).replace('-', ''));
  console.log('作成したGoogle Driveフォルダ:', createdFolder);
  
  // 月末在庫報告書出力アプリに1メーカー1レコードで登録する
  for (const [manufacturerName, recordsByManufacturer] of Object.entries(aggregatedRecords)) {
    // テンプレートSpreadsheetをコピーして、集計結果を埋め込む
    updateStatus(`月末在庫報告書作成中... ${manufacturerName}`);
    const makerCode = recordsByManufacturer[Object.keys(recordsByManufacturer)[0]][0]['メーカーコード'].value;  // メーカーコードを1番目のレコードから取得
    // const inventoryReportFileName = `${today.slice(0, -3).replace('-', '')}_月末在庫報告書_${makerCode}_${manufacturerName}`; // 年月_業務名_メーカーID_メーカー名
    const inventoryReportFileName = `${makerCode}_月末在庫報告書_${manufacturerName}_${today.slice(0, -3).replace('-', '')}`; // メーカーID_業務名_メーカー名_年月
    const copiedSpreadsheet = await copyDriveFile(
      accessToken,
      currentConfig.google.drive['旭川在庫管理'].template_spreadsheet_id,
      inventoryReportFileName,
      createdFolder.id,
      'application/vnd.google-apps.spreadsheet'
    );
    console.log(`月末在庫報告書作成完了: ${manufacturerName}, コピーされたSpreadsheetID: ${copiedSpreadsheet.id}`);
    
    // Spreadsheetに集計結果を埋め込む処理を実装する
    const recordsByManufacturerColumnKeys = [
      '年月', 
      'メーカーコード',
      'メーカー',
      'ブランド品番',
      'CS品番',
      '商品名',
      'カラー',
      'サイズ',
      '数量', // '実在庫', // 実在庫 = 入荷 + B品入荷 − 出荷 − B品返品 アプリ旭川在庫の「入出荷区分」から算出
      'JANコード'
    ];
    const recordsByManufacturerData = [];
    for (const recordsByCsNumber of Object.values(recordsByManufacturer)) {
      let accumulatedRecord = {};
      for (const record of Object.values(recordsByCsNumber)) {
        if (!Object.keys(accumulatedRecord).length) accumulatedRecord = record;
        else {
          switch (record['入出荷区分'].value) {
            case '入荷':
            case 'B品入荷':
              accumulatedRecord['数量'].value = Number(accumulatedRecord['数量'].value) + Number(record['数量'].value);
              break;
            case '出荷':
            case 'B品返品':
              accumulatedRecord['数量'].value = Number(accumulatedRecord['数量'].value) - Number(record['数量'].value);
              break;
            default:
              console.warn(`Unknown 入出荷区分 value: ${record['入出荷区分'].value}`);
              break;
          }
        }
      }
      recordsByManufacturerData.push(accumulatedRecord);
    }
    const recordsByManufacturerMatrix = recordsByManufacturerData.map(record =>
      recordsByManufacturerColumnKeys.map(key => record[key]?.value ?? '')
    );
    
    await writeMatrixAtStartCellOffset(
      accessToken,
      copiedSpreadsheet.id,
      'A1',
      {x: 0, y: 1},
      recordsByManufacturerMatrix,
      {
        sheetName: '旭川在庫管理',
        columnKeys: recordsByManufacturerColumnKeys,
        valueInputOption: 'RAW',  // FIXME: ROWだと数値が文字列(先頭'付与)として扱われるので困るかも?
      }
    );
    
    // Kintoneに月末在庫報告書Excelファイルをアップロードする
    updateStatus(`SpreadsheetをExcelに変換中...${manufacturerName}`);
    const exportedXlsxBlob = await exportSpreadsheetAsXlsx(accessToken, copiedSpreadsheet.id);
    updateStatus(`ExcelファイルをKintoneへアップロード中...${manufacturerName}`);
    const exportedXlsxFileName = `${inventoryReportFileName}.xlsx`;
    const exportedXlsxFileKey = await uploadFileToKintone(exportedXlsxBlob, exportedXlsxFileName);
    
    // 月末在庫報告書出力アプリにレコード登録
    const appId = currentConfig.kintone.app['月末在庫報告書出力'].id;
    const apiToken = currentConfig.kintone.app['月末在庫報告書出力'].api_token;
    const requestBody = {
      app: appId,
      apiToken: apiToken,
      record: {
        'メーカー名': {value: manufacturerName},
        'メーカーID': {value: recordsByManufacturerData[0]['メーカーコード'].value},
        '年月': {value: today},
        '担当者名_TO': {value: recordsByManufacturerData[0]['担当者名_TO'].value},
        'メール宛先_TO': {value: recordsByManufacturerData[0]['メール宛先_TO'].value},
        '担当者名_CC': {value: recordsByManufacturerData[0]['担当者名_CC'].value},
        'メール宛先_CC': {value: recordsByManufacturerData[0]['メール宛先_CC'].value},
        '担当者名_BCC': {value: recordsByManufacturerData[0]['担当者名_BCC'].value},
        'メール宛先_BCC': {value: recordsByManufacturerData[0]['メール宛先_BCC'].value},
        '月末在庫報告書': {value: [{fileKey: exportedXlsxFileKey}]}
      }
    };
    addAppRecord(requestBody).then(resp => {
      console.log('月末在庫報告書出力アプリにレコード登録成功:', resp);
    }).catch(error => {
      console.error('月末在庫報告書出力アプリにレコード登録失敗:', error);
    });
  }
}
