'use strict';
// NEED: config.js
// NEED: GoogleAPIFunctions.js
// NEED: KintoneAPIFunctions.js
// NEED: ui.js

// TODO: エラー処理の強化
// TODO: 各種コメントを追加
// TODO: リファクタリング


/**
 * config選択
 */
const currentConfig = window.config.production;
// const currentConfig = window.config.development;

/**
 * 売上精算書出力ボタン設置
 */
setButton('outputSalesStatement', '売上精算書出力', outputSalesStatement, true);

/**
 * 売上精算書出力のメイン処理
 */
async function outputSalesStatement(updateStatus = () => {}) {
  
  /**
   * 前月分売上発送データ取得
   */
  updateStatus('売上発送データ取得中...');
  const previousMonthSalesShipmentData = await fetchRecordsFromApp(
    currentConfig.kintone.app['Z_売上（発送）'].api_token,
    currentConfig.kintone.app['Z_売上（発送）'].id,
    currentConfig.kintone.app['Z_売上（発送）'].view['前月売上']
  );
  console.log('前月分売上発送データ:', previousMonthSalesShipmentData);
  
   /**
    * 前月分特別処理明細データ取得
   */
  updateStatus('特別処理明細取得中...');
  const previousMonthSpecialProcessingData = await fetchRecordsFromApp(
    currentConfig.kintone.app['Z_特別処理・商品回収明細'].api_token,
    currentConfig.kintone.app['Z_特別処理・商品回収明細'].id,
    currentConfig.kintone.app['Z_特別処理・商品回収明細'].view['前月分明細']
  );
  console.log('前月分特別処理明細データ:', previousMonthSpecialProcessingData);
  
  /**
   * メーカーマスタ取得
   */
  updateStatus('メーカーマスタ取得中...');
  const manufacturerMasterData = await fetchRecordsFromApp(
    currentConfig.kintone.app['メーカーマスタ from SQL'].api_token,
    currentConfig.kintone.app['メーカーマスタ from SQL'].id,
    currentConfig.kintone.app['メーカーマスタ from SQL'].view['連絡先']
  );
  console.log('メーカーマスタデータ:', manufacturerMasterData);
  
  /**
   * 親・子カテゴリマスタ取得
   */
  updateStatus('カテゴリマスタ取得中...');
  const parentChildCategoryMasterData = await fetchRecordsFromApp(
    currentConfig.kintone.app['子カテゴリマスタ'].api_token,
    currentConfig.kintone.app['子カテゴリマスタ'].id
  );
  console.log('親・子カテゴリマスタデータ:', parentChildCategoryMasterData);
  
  /**
   * Goodsinfo取得
   */
  updateStatus('Goodsinfo取得中...');
  const goodsinfoData = await fetchRecordsFromApp(
    currentConfig.kintone.app['Goodsinfo'].api_token,
    currentConfig.kintone.app['Goodsinfo'].id,
    currentConfig.kintone.app['Goodsinfo'].view['先月精算分']
  );
  console.log('Goodsinfoデータ:', goodsinfoData);
  let productMasterDataOfGoodsinfo = [];
  if (goodsinfoData.length > 0) {
    productMasterDataOfGoodsinfo = await fetchRecordsFromApp(
      currentConfig.kintone.app['商品マスタ'].api_token,
      currentConfig.kintone.app['商品マスタ'].id,
      currentConfig.kintone.app['商品マスタ'].view['CS品番'],
      `ブランド品番 in (${goodsinfoData.map(v => '"' + String(v['ブランド品番']?.value).replace(/"/g, '\"') + '"').join(',')})`
    );
    for (const record of goodsinfoData) {
      // ブランド品番では複数レコード出るが、恐らくメーカーは同じなので、最初の1件だけ取得する
      const productMaster = productMasterDataOfGoodsinfo.find(pm => pm['ブランド品番']?.value === record['ブランド品番']?.value);
      record['メーカー名'] = {type: 'SINGLE_LINE_TEXT', value: productMaster?.['メーカー名']?.value || ''}; // メーカーID/メーカーコードを補足
    }
  }

  /**
   * 前月分売上発送データに不足しているものを補填する
   */
  // 商品マスタはレコードが大きいので必要なものだけ取得する
  const salesShipmentProductCSCode = previousMonthSalesShipmentData.map(record => record['CS品番'].value);
  let productMasterDataOfSalesShipment = [];
  if (salesShipmentProductCSCode.length > 0) {
    productMasterDataOfSalesShipment = await fetchRecordsFromApp(
      currentConfig.kintone.app['商品マスタ'].api_token,
      currentConfig.kintone.app['商品マスタ'].id,
      currentConfig.kintone.app['商品マスタ'].view['CS品番'],
      `CS別品番 in (${salesShipmentProductCSCode.map(v => '"' + String(v).replace(/"/g, '\"') + '"').join(',')})`
    );
  }
  previousMonthSalesShipmentData.forEach(record => {
    const productMaster = productMasterDataOfSalesShipment.find(pm => pm['CS別品番']?.value === record['CS品番']?.value);
    const parentChildCategoryMaster = parentChildCategoryMasterData.find(pccm => pccm['子カテゴリID']?.value === productMaster?.['子カテゴリコード']?.value);
    const manufacturerMaster = manufacturerMasterData.find(mm => mm['メーカーID']?.value === parentChildCategoryMaster?.['メーカーコード']?.value);
    // record['登録メーカーID'] = {type: 'NUMBER', value: productMaster?.['登録メーカーID']?.value || ''}; // 登録メーカーIDが設定されていない場合があるので子カテゴリマスタから取得
    record['メーカーコード'] = {type: 'NUMBER', value: parentChildCategoryMaster?.['メーカーコード']?.value || ''};
    record['子カテゴリーID'] = {type: 'SINGLE_LINE_TEXT', value: productMaster?.['子カテゴリコード']?.value || ''};
    record['元品番'] = {type: 'SINGLE_LINE_TEXT', value: productMaster?.['元品番']?.value || ''};
    record['種別'] = {type: 'SINGLE_LINE_TEXT', value: (record['出荷数'].value >= 0)?'出荷売上高':'返品'};  // "出荷数+ であれば出荷売上高, 出荷数- であれば返品
    record['精算区分'] = {type: 'SINGLE_LINE_TEXT', value: parentChildCategoryMaster?.['精算区分']?.value || ''};
    switch(record['価格タイプ']?.value) {
      case 'プロパー': record['価格タイプ区分'] = {type: 'SINGLE_LINE_TEXT', value: '1'}; break;
      case 'セール': record['価格タイプ区分'] = {type: 'SINGLE_LINE_TEXT', value: '2'}; break;
    }
    record['掛率'] = {type: 'NUMBER', value: parentChildCategoryMaster?.['精算掛率']?.value || 100};
    switch(record['精算区分']?.value) {
      case '1：販売価格': record['単価(下代)'] = {type: 'NUMBER', value: Math.trunc((record['販売価格_税抜_']?.value * record['掛率']?.value) / 100 * 10) / 10};  // 販売価格*メーカーマスタ.掛率
        break;
      case '2：元上代': record['単価(下代)'] = {type: 'NUMBER', value: Math.trunc((record['プロパー価格_税抜_']?.value * record['掛率']?.value) / 100 * 10) / 10};  // 元上代*メーカーマスタ.掛率
        break;
    }
    record['下代合計金額'] = {type: 'NUMBER', value: record['単価(下代)']?.value * record['出荷数']?.value}; // 単価(下代)*出荷数
    record['適格請求書事業者コード'] = {type: 'SINGLE_LINE_TEXT', value: manufacturerMaster?.['適格請求書事業者コード']?.value || ''};
  });
  
  /**
   * 前月分特別処理明細データに不足しているものを補填する
   */
  // 商品マスタはレコードが大きいので必要なものだけ取得する
  const specialProcessingProductCSCode = previousMonthSpecialProcessingData.map(record => record['CS品番'].value);
  let productMasterDataOfSpecialProcessing = [];
  if (specialProcessingProductCSCode.length > 0) {
    productMasterDataOfSpecialProcessing = await fetchRecordsFromApp(
      currentConfig.kintone.app['商品マスタ'].api_token,
      currentConfig.kintone.app['商品マスタ'].id,
      currentConfig.kintone.app['商品マスタ'].view['CS品番'],
      `CS別品番 in (${specialProcessingProductCSCode.map(v => '"' + String(v).replace(/"/g, '\"') + '"').join(',')})`
    );
  }
  previousMonthSpecialProcessingData.forEach(record => {
    const productMaster = productMasterDataOfSpecialProcessing.find(pm => pm['CS別品番']?.value === record['CS品番']?.value);
    const parentChildCategoryMaster = parentChildCategoryMasterData.find(pccm => pccm['子カテゴリID']?.value === productMaster?.['子カテゴリコード']?.value);
    const manufacturerMaster = manufacturerMasterData.find(mm => mm['メーカーID']?.value === parentChildCategoryMaster?.['メーカーコード']?.value);
    // record['登録メーカーID'] = {type: 'NUMBER', value: productMaster?.['登録メーカーID']?.value || ''}; // 登録メーカーIDが設定されていない場合があるので子カテゴリマスタから取得
    record['メーカーコード'] = {type: 'NUMBER', value: parentChildCategoryMaster?.['メーカーコード']?.value || ''};
    record['子カテゴリーID'] = {type: 'SINGLE_LINE_TEXT', value: productMaster?.['子カテゴリコード']?.value || ''};
    record['子カテゴリー名'] = {type: 'SINGLE_LINE_TEXT', value: parentChildCategoryMaster?.['子カテゴリ名']?.value || ''};
    record['メーカー名'] = {type: 'SINGLE_LINE_TEXT', value: productMaster?.['メーカー名']?.value || 'メーカー不明'};
    record['掛率'] = {type: 'NUMBER', value: parentChildCategoryMaster?.['精算掛率']?.value || 100};
    record['下代合計金額'] = {type: 'NUMBER', value: Math.trunc((record['合計_税抜_']?.value * record['掛率']?.value) / 100 * 10) /10};  // 特別処理データに単価がないので合計金額から出す
    record['下代単価'] = {type: 'NUMBER', value: Math.trunc((record['下代合計金額']?.value / record['数量']?.value) * 10) / 10};
    record['適格請求書事業者コード'] = {type: 'SINGLE_LINE_TEXT', value: manufacturerMaster?.['適格請求書事業者コード']?.value || ''};
  });
  
  /**
   * 前月分売上発送データを元に、メーカーごとデータへグルーピング、さらにCS品番＋価格でグルーピングしたデータも作成
   */
  updateStatus('売上発送データのグルーピング中...');
  const salesShipmentDataByManufacturer = {};
  previousMonthSalesShipmentData.forEach(record => {
    // const manufacturerName = record['親カテゴリ']?.value || 'メーカー不明';
    const manufacturerCode = parentChildCategoryMasterData.find(pccm=>pccm['親カテゴリ名'].value==record['親カテゴリ'].value)['メーカーコード'];
    const manufacturerName = manufacturerMasterData.find(mm=>mm['メーカーID'].value === manufacturerCode.value)['メーカー名'].value || 'メーカー不明';
    if (!salesShipmentDataByManufacturer[manufacturerName]) {
      salesShipmentDataByManufacturer[manufacturerName] = {};
    }
    const csCode = record['CS品番']?.value || 'CS品番不明';
    if (!salesShipmentDataByManufacturer[manufacturerName][csCode]) {
      salesShipmentDataByManufacturer[manufacturerName][csCode] = {};
    }
    const salePrice = record['販売価格_税抜_']?.value || '販売価格不明'; // 合計金額_税抜_ = 販売価格_税抜_ * 出荷数(ここが負の数になる場合があるので販売価格でグルーピングする)
    if (!salesShipmentDataByManufacturer[manufacturerName][csCode][salePrice]) {
      salesShipmentDataByManufacturer[manufacturerName][csCode][salePrice] = [];
    }
    salesShipmentDataByManufacturer[manufacturerName][csCode][salePrice].push(record);
  });
  console.log('売上発送データ(メーカー/CS品番/合計金額ごと):', salesShipmentDataByManufacturer);
  
  /**
   * 前月分特別処理明細データを元に、メーカーごとデータへグルーピング
   */
  updateStatus('特別処理明細のグルーピング中...');
  const specialProcessingDataByManufacturer = {};
  previousMonthSpecialProcessingData.forEach(record => {
    const manufacturerName = record['メーカー名']?.value || 'メーカー不明';
    if (!specialProcessingDataByManufacturer[manufacturerName]) {
      specialProcessingDataByManufacturer[manufacturerName] = [];
    }
    specialProcessingDataByManufacturer[manufacturerName].push(record);
  });
  console.log('特別処理明細データ(メーカーごと):', specialProcessingDataByManufacturer);
  
  /**
   * Google Drive APIを使用して、取引先別売上精算書出力用のフォルダとExcelファイルを作成し、Kintoneのデータを差し込む
   */
  updateStatus('Googleアクセストークン取得中...');
  const accessToken = await getAccessToken();
  
  // 売上発送データの1つ目の出荷日を元に年月を取得
  const firstShipmentDate = previousMonthSalesShipmentData[0]?.['出荷日']?.value; // "2026-03-01"
  const targetYearMonth = firstShipmentDate ? firstShipmentDate.slice(0, 7).replace('-', '') : '出荷日不明'; // "202603"
  
  const parentFolderId = currentConfig.google.drive['取引先別売上精算書出力'].target_folder_id;
  updateStatus('Google Driveフォルダ作成中...');
  const createdFolder = await createDriveFolder(accessToken, parentFolderId, targetYearMonth);
  console.log('作成したGoogle Driveフォルダ:', createdFolder);
  
  /**
   * 取引先別売上精算書出力のレコード追加
   */
  updateStatus('レコード追加中...');
  const appId = kintone.app.getId();
  let manufacturerNames = Object.keys(salesShipmentDataByManufacturer);
  let totalManufacturers = manufacturerNames.length;
  for (const [manufacturerIndex, manufacturer] of manufacturerNames.entries()) {
    const progressLabel = `(${manufacturerIndex + 1}件目/${totalManufacturers}件中)`;
    const progressWithManufacturerLabel = `${manufacturer}様${progressLabel}`;
    if (manufacturer != "メーカー不明") {// メーカーが不明なデータはスキップする
      updateStatus(`レコード追加中...${progressWithManufacturerLabel}`);
      const manufacturerMaster = manufacturerMasterData.find(mm => mm['メーカー名']?.value === manufacturer);
      
      const makerCode = Object.values(salesShipmentDataByManufacturer[manufacturer]).flatMap(level1 =>
        Object.values(level1).flatMap(arr => Array.isArray(arr) ? arr : [])
      ).find(record => {
        const v = record?.["メーカーコード"]?.value;
        return v !== "" && v !== null && v !== undefined;
      })['メーカーコード'].value;
      
      updateStatus(`テンプレートSpreadsheetコピー作成中...${progressWithManufacturerLabel}`);
      const fileName = `${targetYearMonth}_売上精算_${makerCode}_${manufacturer}様`;  // 年月_業務名_メーカーID_メーカー名
      const templateSpreadsheetId = currentConfig.google.drive['取引先別売上精算書出力'].template_spreadsheet_id;
      const copiedSpreadsheet = await copyDriveFile(
        accessToken,
        templateSpreadsheetId,
        fileName,
        createdFolder.id,
        'application/vnd.google-apps.spreadsheet'
      );
      console.log('作成したテンプレートSpreadsheetコピー:', copiedSpreadsheet);
      
      // メーカー名を挿入
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'A2:R2',
        [[manufacturer]],
        {
          sheetName: '精算書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'AA3:AC3',
        [[manufacturer]],
        {
          sheetName: '請求書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'A2:D2',
        [[manufacturer]],
        {
          sheetName: '広告費 請求書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      
      // 住所を挿入
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'AA4:AC4',
        [[manufacturerMaster['住所1']?.value || '']],
        {
          sheetName: '請求書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'AA5:AC5',
        [[manufacturerMaster['住所2']?.value || '']],
        {
          sheetName: '請求書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      
      // 電話番号を挿入
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'AB6:AC6',
        [[manufacturerMaster['TEL']?.value || '']],
        {
          sheetName: '請求書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      
      // 本日の日付をYYYY/MM/DD形式でAB1セルに挿入
      const today = new Date();
      const formattedDate = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'AB1:AC1',
        [[formattedDate]],
        {
          sheetName: '精算書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'AB1:AC1',
        [[formattedDate]],
        {
          sheetName: '請求書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'M1',
        [[formattedDate]],
        {
          sheetName: '広告費 請求書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      
      let nameTo = [];  // 担当者名_TO
      let mailTo = [];  // メール宛先_TO
      let nameCc = [];  // 担当者名_CC
      let mailCc = [];  // メール宛先_CC
      if (manufacturerMaster['連絡先'].value.length > 0) {
        // 担当者 To
        for (const contact of manufacturerMaster['連絡先'].value.filter(item => item.value.宛先種別.value.includes("精算（TO）"))) {
          nameTo.push(contact.value['担当者名'].value);
          mailTo.push(contact.value['メールアドレス'].value);
        }
        // 担当者名 Cc
        for (const contact of manufacturerMaster['連絡先'].value.filter(item => item.value.宛先種別.value.includes("精算（CC）"))) {
          nameCc.push(contact.value['担当者名'].value);
          mailCc.push(contact.value['メールアドレス'].value);
        }
      }
      nameTo = nameTo.join(',');
      mailTo = mailTo.join(',');
      nameCc = nameCc.join(',');
      mailCc = mailCc.join(',');
      
      const summarySheetColumnKeys = [
        '親カテゴリー',
        '子カテゴリー',
        '商品タイプ',
        '性別',
        'ブランド品番',
        '商品名',
        'CS品番',
        'カラー',
        'サイズ',
        '販売価格',
        '価格タイプ',
        '元上代',
        '出荷数',
        '合計金額',
        '掛率',
        '単価(下代)',
        '下代合計金額',
        'バーコード'
      ];
      const summarySheetData = []; // まとめ「CS品番＋販売価格毎」 シート用データ
      const salesBreakdownSheetColumnKeys = [
        '種別',
        'I',
        'J',
        '親カテゴリー',
        '子カテゴリー',
        '子カテゴリーID',
        'FUNALIVE独自子カテID',
        '親商品タイプ',
        '子商品タイプ',
        '性別',
        'ブランド品番',
        '商品名',
        'CS品番',
        '元品番',
        'カラー',
        'サイズ',
        '販売価格',
        '販売タイプ',
        '価格タイプ区分',
        '価格タイプ',
        '元上代',
        '出荷数',
        '合計金額',
        '出荷日',
        '掛率',
        '単価(下代)',
        '下代合計金額',
        '税率',
        '消費税',
        '税込下代合計金額',
        'バーコード',
        '精算日',
        '精算区分'
      ];
      const salesBreakdownSheetData = []; // 売上明細　明細 シート用データ
      const specialProcessingSheetColumnKeys = [
        '種別',
        'メーカーコード', // 非表示
        '親カテゴリー名', // 非表示
        '子カテゴリー名',
        '子カテゴリーID',
        'FUNALIVE独自子カテID', // 非表示
        '日付',
        '品番',
        'CS品番',
        'カラー',
        'サイズ',
        '数量',
        '合計(税抜)',
        '詳細',
        '備考',
        'モール',
        '元出荷日',
        '税率',
        '手数料率',
        '掛率',
        '下代単価',
        '下代合計金額',
        '消費税', // 非表示
        '税込下代合計金額', // 非表示
        '精算日'  // 非表示
      ];
      const specialProcessingSheetData = []; // 特別処理　明細 シート用データ
      
      const advertisingSheetColumnKeys = [
        '種別名',
        '日付',
        '親カテゴリ名',
        '子カテゴリ名',
        'ブランド品番',
        '商品コード',
        '商品名',
        '商品親タイプ',
        '商品子タイプ',
        'アップロード日',
        'imp',
        'click',
        'コスト',
        '経由売上点数',
        '経由売上金額',
        'CTR',
        'CPC',
        'ROAS'
      ];
      const advertisingSheetData = []; // 広告費明細
      const goodsinfoDataByManufacturer = goodsinfoData.filter(record => record['メーカー名']?.value === manufacturer);
      if (goodsinfoDataByManufacturer.length > 0) {
        advertisingSheetData.push(...goodsinfoDataByManufacturer.map(record => ({
          '種別名': record['種別名']?.value || '',  // FIXME: ?
          '日付': record['精算日']?.value || '',  // FIXME: ?
          '親カテゴリ名': record['親カテゴリ']?.value || '',
          '子カテゴリ名': record['子カテゴリ']?.value || '',
          'ブランド品番': record['ブランド品番']?.value || '',
          '商品コード': record['商品コード']?.value || '',
          '商品名': record['商品名']?.value || '',
          '商品親タイプ': record['親商品タイプ']?.value || '',
          '商品子タイプ': record['子商品タイプ']?.value || '',
          'アップロード日': record['アップロード日']?.value || '',
          'imp': record['imp']?.value || 0,
          'click': record['click']?.value || 0,
          'コスト': record['コスト']?.value || 0,
          '経由売上点数': record['経由売上件数']?.value || 0,
          '経由売上金額': record['経由売上金額_税抜_']?.value || 0,
          'CTR': record['CTR']?.value || 0,
          'CPC': record['CPC']?.value || 0,
          'ROAS': record['ROAS']?.value || 0
        })));
      }
      if (advertisingSheetData.length > 0) {
        await writeMatrixAtStartCellOffset(
          accessToken,
          copiedSpreadsheet.id,
          'A1',
          {x: 0, y: 1},
          advertisingSheetData,
          {
            sheetName: '広告費明細',
            columnKeys: advertisingSheetColumnKeys
          }
        );
      }
      
      let billingMonth = '' // 精算書/請求書に記載する年月
      let invoiceRegistrationNumber = '' // 適格事業登録コード
      for (const csCode in salesShipmentDataByManufacturer[manufacturer]) {
        for (const salePrice in salesShipmentDataByManufacturer[manufacturer][csCode]) {
          for (const record of salesShipmentDataByManufacturer[manufacturer][csCode][salePrice]) {
            billingMonth = record['出荷日']?.value  // 精算書/請求書に記載する年月を出荷日に値があったら取得
            invoiceRegistrationNumber = record['適格請求書事業者コード']?.value; // 適格事業登録コード
            
            summarySheetData.push({
              '親カテゴリー': record['親カテゴリ']?.value || '',
              '子カテゴリー': record['子カテゴリ']?.value || '',
              '親商品タイプ': record['親商品タイプ']?.value || '',
              '子商品タイプ': record['子商品タイプ']?.value || '',
              '性別': record['性別']?.value || '',
              'ブランド品番': record['ブランド品番']?.value || '',
              '商品名': record['商品名']?.value || '',
              'CS品番': record['CS品番']?.value || '',
              'カラー': record['カラー']?.value || '',
              'サイズ': record['サイズ']?.value || '',
              '販売価格': record['販売価格_税抜_']?.value || '',
              '価格タイプ': record['価格タイプ']?.value || '',
              '元上代': record['プロパー価格_税抜_']?.value || '',  // 項目名もプロパー価格になる?
              '出荷数': record['出荷数']?.value || '',
              '合計金額': record['合計金額_税抜_']?.value || '',
              '掛率': record['掛率']?.value || '',  // メーカーマスタ.掛率
              '単価(下代)': record['単価(下代)']?.value || '', // 販売価格*メーカーマスタ.掛率
              '下代合計金額': record['下代合計金額']?.value || '', // 単価(下代)*出荷数
              'バーコード': record['バーコード']?.value || ''
            });
            
            salesBreakdownSheetData.push({
              '種別': record['種別']?.value || '',  // "出荷数+ であれば出荷売上高、出荷数- であれば返品
              'I': '',  // I列は空白
              'J': '',  // J列は空白
              '親カテゴリー': record['親カテゴリ']?.value || '',
              '子カテゴリー': record['子カテゴリ']?.value || '',
              '子カテゴリーID': record['子カテゴリーID']?.value || '',  // "ZOZO子カテゴリマスタ.xlsx 親カテゴリー 子カテゴリーでのマッチ
              'FUNALIVE独自子カテID': record['FUNALIVE独自子カテID']?.value || '',  // 不要?
              '親商品タイプ': record['親商品タイプ']?.value || '',
              '子商品タイプ': record['子商品タイプ']?.value || '',
              '性別': record['性別']?.value || '',
              'ブランド品番': record['ブランド品番']?.value || '',
              '商品名': record['商品名']?.value || '',
              'CS品番': record['CS品番']?.value || '',
              '元品番': record['元品番']?.value || '',
              'カラー': record['カラー']?.value || '',
              'サイズ': record['サイズ']?.value || '',
              '販売価格': record['販売価格_税抜_']?.value || '',
              '販売タイプ': record['販売タイプ']?.value || '',
              '価格タイプ区分': record['価格タイプ区分']?.value || '',
              '価格タイプ': record['価格タイプ']?.value || '',
              '元上代': record['プロパー価格_税抜_']?.value || '',  // 項目名もプロパー価格になる?
              '出荷数': record['出荷数']?.value || '',
              '合計金額': record['合計金額_税抜_']?.value || '',
              '出荷日': record['出荷日']?.value || '',
              '掛率': record['掛率']?.value || '',  // メーカーマスタ.掛率
              '単価(下代)': record['単価(下代)']?.value || '', // 販売価格*メーカーマスタ.掛率
              '下代合計金額': record['下代合計金額']?.value || '', // 単価(下代)*出荷数
              '税率': '',  // 非表示
              '消費税': '',  // 非表示
              '税込下代合計金額': '',  // 非表示
              'バーコード': record['バーコード']?.value || '',
              '精算日': '',  // 非表示
              '精算区分': record['精算区分']?.value || ''  // 非表示
            });
          }
        }
      }
      
      // 特別処理明細データが存在する場合、特別処理　明細 シート用データも作成
      if (specialProcessingDataByManufacturer[manufacturer]) {
        specialProcessingDataByManufacturer[manufacturer].forEach(specialRecord => {
          specialProcessingSheetData.push({
            '種別': specialRecord['種別']?.value || '',
            'メーカーコード': '', // 非表示
            '親カテゴリー名': '', // 非表示
            '子カテゴリー名': specialRecord['子カテゴリー名']?.value || '',
            '子カテゴリーID': specialRecord['子カテゴリーID']?.value || '',
            'FUNALIVE独自子カテID': '', // 非表示
            '日付': specialRecord['日付']?.value || '',
            '品番': specialRecord['品番']?.value || '',
            'CS品番': specialRecord['CS品番']?.value || '',
            'カラー': specialRecord['カラー']?.value || '',
            'サイズ': specialRecord['サイズ']?.value || '',
            '数量': specialRecord['数量']?.value || '',
            '合計(税抜)': specialRecord['合計_税抜_']?.value || '',
            '詳細': specialRecord['詳細']?.value || '',
            '備考': specialRecord['備考']?.value || '',
            'モール': specialRecord['モール']?.value || '',
            '元出荷日': specialRecord['元出荷日']?.value || '',
            '税率': specialRecord['税率']?.value || '',
            '手数料率': specialRecord['手数料率']?.value || '',
            '掛率': specialRecord['掛率']?.value || '', // メーカーマスタ.掛率?
            '下代単価': specialRecord['下代単価']?.value || '', // 販売価格*メーカーマスタ.掛率?
            '下代合計金額': specialRecord['下代合計金額']?.value || '', // 下代単価*数量?
            '消費税': '', // 非表示
            '税込下代合計金額': '', // 非表示
            '精算日': ''  // 非表示
          });
        });
        
        // 抽出した特別処理データは配列から削除
        delete specialProcessingDataByManufacturer[manufacturer];
      }
      
      // 精算書/請求書の年月を `YYYY年MM月分` (0埋めしない) 形式で差し込み
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'U2:V2',
        [[billingMonth ? `${new Date(billingMonth).getFullYear()}年${new Date(billingMonth).getMonth() + 1}月分` : '' ]],
        {
          sheetName: '精算書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'U2:V2',
        [[billingMonth ? `${new Date(billingMonth).getFullYear()}年${new Date(billingMonth).getMonth() + 1}月分` : '' ]],
        {
          sheetName: '請求書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'G2:H2',
        [[billingMonth ? `${new Date(billingMonth).getFullYear()}年${new Date(billingMonth).getMonth() + 1}月分` : '' ]],
        {
          sheetName: '広告費 請求書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      
      // 請求書の適格請求書事業者コードを差し込み
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'AB2',
        [[invoiceRegistrationNumber]],
        {
          sheetName: '請求書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      
      await writeMatrixAtStartCellOffset(
        accessToken,
        copiedSpreadsheet.id,
        'A1',
        {x: 0, y: 1},
        mergeByCsAndPrice(summarySheetData),
        {
          sheetName: 'まとめ「CS品番＋販売価格毎」',
          columnKeys: summarySheetColumnKeys
        }
      );
      
      await writeMatrixAtStartCellOffset(
        accessToken,
        copiedSpreadsheet.id,
        'H1',
        {x: 0, y: 1},
        salesBreakdownSheetData,
        {
          sheetName: '売上明細　明細',
          columnKeys: salesBreakdownSheetColumnKeys
        }
      );
      
      if (specialProcessingSheetData.length > 0) {
        await writeMatrixAtStartCellOffset(
          accessToken,
          copiedSpreadsheet.id,
          'G1',
          {x: 0, y: 1},
          specialProcessingSheetData,
          {
            sheetName: '特別処理　明細',
            columnKeys: specialProcessingSheetColumnKeys
          }
        );
      }
      
      // `精算書` シートから消費税を取得
      const consumptionTax = await getSpreadsheetValue(
        accessToken,
        copiedSpreadsheet.id,
        '精算書',
        'T6',
        {
          valueRenderOption: 'UNFORMATTED_VALUE'
        }
      );
      // `精算書` シートからご精算金額を取得
      const totalWithTax = await getSpreadsheetValue(
        accessToken,
        copiedSpreadsheet.id,
        '精算書',
        'S5',
        {
          valueRenderOption: 'UNFORMATTED_VALUE'
        }
      );
      const total = totalWithTax - consumptionTax;
      
      // `精算書` シートから広告費、消費税(広告費)を取得
      const advertisingCost = await getSpreadsheetValue(
        accessToken,
        copiedSpreadsheet.id,
        '精算書',
        'U8',
        {
          valueRenderOption: 'UNFORMATTED_VALUE'
        }
      );
      const advertisingConsumptionTax = await getSpreadsheetValue(
        accessToken,
        copiedSpreadsheet.id,
        '精算書',
        'V8',
        {
          valueRenderOption: 'UNFORMATTED_VALUE'
        }
      );
      
      updateStatus(`SpreadsheetをExcelに変換中...${progressWithManufacturerLabel}`);
      const exportedXlsxBlob = await exportSpreadsheetAsXlsx(accessToken, copiedSpreadsheet.id);

      updateStatus(`ExcelファイルをKintoneへアップロード中...${progressWithManufacturerLabel}`);
      const exportedXlsxFileName = `${fileName}.xlsx`;
      const exportedXlsxFileKey = await uploadFileToKintone(exportedXlsxBlob, exportedXlsxFileName);
      
      const requestBody = {
        app: appId,
        record: {
          "メーカー名": { value: manufacturer },
          "年月": { value: new Date().toISOString().split('T')[0] },
          "担当者名_TO": { value: nameTo },
          "メール宛先_TO": { value: mailTo },
          "担当者名_CC": { value: nameCc },
          "メール宛先_CC": { value: mailCc },
          "売上精算書": { value: [{ fileKey: exportedXlsxFileKey }] },
          "売上額_税抜_": { value: total },
          "消費税": { value: consumptionTax },
          "税率": { value: 10 }, // TODO: ここ固定?
          "広告費・画像使用料など_税抜_": { value: advertisingCost },
          "広告費・画像使用料など_消費税_": { value: advertisingConsumptionTax },
          "税込売上額": { value: totalWithTax },
          "メーカー_売上額_税抜_": { value: total },  // 初期値は同額設定
          "メーカー_消費税": { value: consumptionTax }  // 初期値は同額設定
        }
      };
      await addAppRecord(requestBody);
    }
  }
  
  // 特別処理データのみのメーカーを出力
  manufacturerNames = Object.keys(specialProcessingDataByManufacturer);
  totalManufacturers = manufacturerNames.length;
  for (const [manufacturerIndex, manufacturer] of manufacturerNames.entries()) {
    if (manufacturer != "メーカー不明") { // メーカーが不明なデータはスキップする
      const progressLabel = `(${manufacturerIndex + 1}件目/${totalManufacturers}件中)`;
      const progressWithManufacturerLabel = `${manufacturer}様${progressLabel}`;
      updateStatus(`レコード追加中...${progressWithManufacturerLabel}`);
      const manufacturerMaster = manufacturerMasterData.find(mm => mm['メーカー名']?.value === manufacturer);
      
      const makerCode = specialProcessingDataByManufacturer[manufacturer].find(item => {
        const v = item?.["メーカーコード"]?.value;
        return v != null && String(v).trim() !== "";
      })?.['メーカーコード']?.value;
      
      updateStatus(`テンプレートSpreadsheetコピー作成中...${progressWithManufacturerLabel}`);
      const templateSpreadsheetId = currentConfig.google.drive['取引先別売上精算書出力'].template_spreadsheet_id;
      const fileName = `${targetYearMonth}_売上精算_${makerCode}_${manufacturer}様`;  // 年月_業務名_メーカーID_メーカー名
      const copiedSpreadsheet = await copyDriveFile(
        accessToken,
        templateSpreadsheetId,
        fileName,
        createdFolder.id,
        'application/vnd.google-apps.spreadsheet'
      );
      console.log('作成したテンプレートSpreadsheetコピー:', copiedSpreadsheet);
      
      // メーカー名を挿入
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'A2:R2',
        [[manufacturer]],
        {
          sheetName: '精算書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'AA3:AC3',
        [[manufacturer]],
        {
          sheetName: '請求書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      
      // 住所を挿入
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'AA4:AC4',
        [[manufacturerMaster['住所1']?.value || '']],
        {
          sheetName: '請求書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'AA5:AC5',
        [[manufacturerMaster['住所2']?.value || '']],
        {
          sheetName: '請求書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      
      // 電話番号を挿入
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'AB6:AC6',
        [[manufacturerMaster['TEL']?.value || '']],
        {
          sheetName: '請求書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      
      // 本日の日付をYYYY/MM/DD形式でAB1セルに挿入
      const today = new Date();
      const formattedDate = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'AB1:AC1',
        [[formattedDate]],
        {
          sheetName: '精算書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'AB1:AC1',
        [[formattedDate]],
        {
          sheetName: '請求書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      
      let nameTo = [];  // 担当者名_TO
      let mailTo = [];  // メール宛先_TO
      let nameCc = [];  // 担当者名_CC
      let mailCc = [];  // メール宛先_CC
      if (manufacturerMaster['連絡先'].value.length > 0) {
        // 担当者 To
        for (const contact of manufacturerMaster['連絡先'].value.filter(item => item.value.宛先種別.value.includes("精算（TO）"))) {
          nameTo.push(contact.value['担当者名'].value);
          mailTo.push(contact.value['メールアドレス'].value);
        }
        // 担当者名 Cc
        for (const contact of manufacturerMaster['連絡先'].value.filter(item => item.value.宛先種別.value.includes("精算（CC）"))) {
          nameCc.push(contact.value['担当者名'].value);
          mailCc.push(contact.value['メールアドレス'].value);
        }
      }
      nameTo = nameTo.join(',');
      mailTo = mailTo.join(',');
      nameCc = nameCc.join(',');
      mailCc = mailCc.join(',');
      
      const specialProcessingSheetColumnKeys = [
        '種別',
        'メーカーコード', // 非表示
        '親カテゴリー名', // 非表示
        '子カテゴリー名',
        '子カテゴリーID',
        'FUNALIVE独自子カテID', // 非表示
        '日付',
        '品番',
        'CS品番',
        'カラー',
        'サイズ',
        '数量',
        '合計(税抜)',
        '詳細',
        '備考',
        'モール',
        '元出荷日',
        '税率',
        '手数料率',
        '掛率',
        '下代単価',
        '下代合計金額',
        '消費税', // 非表示
        '税込下代合計金額', // 非表示
        '精算日'  // 非表示
      ];
      const specialProcessingSheetData = []; // 特別処理　明細 シート用データ
      
      let billingMonth = '' // 精算書/請求書に記載する年月
      let invoiceRegistrationNumber = '' // 適格事業登録コード
      // 特別処理明細データが存在する場合、特別処理　明細 シート用データも作成
      specialProcessingDataByManufacturer[manufacturer].forEach(specialRecord => {
        billingMonth = specialRecord['日付']?.value  // 精算書/請求書に記載する年月を出荷日に値があったら取得
        invoiceRegistrationNumber = specialRecord['適格請求書事業者コード']?.value; // 適格事業登録コード
        
        specialProcessingSheetData.push({
          '種別': specialRecord['種別']?.value || '',
          'メーカーコード': '', // 非表示
          '親カテゴリー名': '', // 非表示
          '子カテゴリー名': specialRecord['子カテゴリー名']?.value || '',
          '子カテゴリーID': specialRecord['子カテゴリーID']?.value || '',
          'FUNALIVE独自子カテID': '', // 非表示
          '日付': specialRecord['日付']?.value || '',
          '品番': specialRecord['品番']?.value || '',
          'CS品番': specialRecord['CS品番']?.value || '',
          'カラー': specialRecord['カラー']?.value || '',
          'サイズ': specialRecord['サイズ']?.value || '',
          '数量': specialRecord['数量']?.value || '',
          '合計(税抜)': specialRecord['合計_税抜_']?.value || '',
          '詳細': specialRecord['詳細']?.value || '',
          '備考': specialRecord['備考']?.value || '',
          'モール': specialRecord['モール']?.value || '',
          '元出荷日': specialRecord['元出荷日']?.value || '',
          '税率': specialRecord['税率']?.value || '',
          '手数料率': specialRecord['手数料率']?.value || '',
          '掛率': specialRecord['掛率']?.value || '', // メーカーマスタ.掛率?
          '下代単価': specialRecord['下代単価']?.value || '', // 販売価格*メーカーマスタ.掛率?
          '下代合計金額': specialRecord['下代合計金額']?.value || '', // 下代単価*数量?
          '消費税': '', // 非表示
          '税込下代合計金額': '', // 非表示
          '精算日': ''  // 非表示
        });
      });
      
      // 精算書/請求書の年月を `YYYY年MM月分` (0埋めしない) 形式で差し込み
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'U2:V2',
        [[billingMonth ? `${new Date(billingMonth).getFullYear()}年${new Date(billingMonth).getMonth() + 1}月分` : '' ]],
        {
          sheetName: '精算書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'U2:V2',
        [[billingMonth ? `${new Date(billingMonth).getFullYear()}年${new Date(billingMonth).getMonth() + 1}月分` : '' ]],
        {
          sheetName: '請求書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      
      // 請求書の適格請求書事業者コードを差し込み
      await updateSpreadsheetValues(
        accessToken,
        copiedSpreadsheet.id,
        'AB2',
        [[invoiceRegistrationNumber]],
        {
          sheetName: '請求書',
          valueInputOption: 'USER_ENTERED',
          majorDimension: 'ROWS'
        }
      );
      
      if (specialProcessingSheetData.length > 0) {
        await writeMatrixAtStartCellOffset(
          accessToken,
          copiedSpreadsheet.id,
          'G1',
          {x: 0, y: 1},
          specialProcessingSheetData,
          {
            sheetName: '特別処理　明細',
            columnKeys: specialProcessingSheetColumnKeys
          }
        );
      }
      
      // `精算書` シートから消費税を取得
      const consumptionTax = await getSpreadsheetValue(
        accessToken,
        copiedSpreadsheet.id,
        '精算書',
        'T6',
        {
          valueRenderOption: 'UNFORMATTED_VALUE'
        }
      );
      // `精算書` シートからご精算金額を取得
      const totalWithTax = await getSpreadsheetValue(
        accessToken,
        copiedSpreadsheet.id,
        '精算書',
        'S5',
        {
          valueRenderOption: 'UNFORMATTED_VALUE'
        }
      );
      const total = totalWithTax - consumptionTax;
      
      updateStatus(`SpreadsheetをExcelに変換中...${progressWithManufacturerLabel}`);
      const exportedXlsxBlob = await exportSpreadsheetAsXlsx(accessToken, copiedSpreadsheet.id);

      updateStatus(`ExcelファイルをKintoneへアップロード中...${progressWithManufacturerLabel}`);
      const exportedXlsxFileName = `${fileName}.xlsx`;
      const exportedXlsxFileKey = await uploadFileToKintone(exportedXlsxBlob, exportedXlsxFileName);
      
      const requestBody = {
        app: appId,
        record: {
          "メーカー名": { value: manufacturer },
          "年月": { value: new Date().toISOString().split('T')[0] },
          "担当者名_TO": { value: nameTo },
          "メール宛先_TO": { value: mailTo },
          "担当者名_CC": { value: nameCc },
          "メール宛先_CC": { value: mailCc },
          "売上精算書": { value: [{ fileKey: exportedXlsxFileKey }] },
          "売上額_税抜_": { value: total },
          "消費税": { value: consumptionTax },
          "税率": { value: 10 }, // TODO: ここ固定?
          "税込売上額": { value: totalWithTax },
          "メーカー_売上額_税抜_": { value: total },  // 初期値は同額設定
          "メーカー_消費税": { value: consumptionTax }  // 初期値は同額設定
        }
      };
      await addAppRecord(requestBody);
    }
  }
  return;
}

// --- Main Processing Functions ---

// 同一CS品番＋販売価格の行をまとめる（出荷数、合計金額、下代合計金額を合算）
function mergeByCsAndPrice(rows) {
  const toNumber = (v) => {
    if (typeof v === "number") return v;
    return Number(String(v).replace(/,/g, "")) || 0;
  };

  return Object.values(
    rows.reduce((acc, row) => {
      const key = row["CS品番"] + "||" + row["販売価格"];

      if (!acc[key]) {
        acc[key] = {
          ...row,
          _sumShip: toNumber(row["出荷数"]),
          _sumTotal: toNumber(row["合計金額"]),
          _sumLowerTotal: toNumber(row["下代合計金額"])
        };
        return acc;
      }

      acc[key]._sumShip += toNumber(row["出荷数"]);
      acc[key]._sumTotal += toNumber(row["合計金額"]);
      acc[key]._sumLowerTotal += toNumber(row["下代合計金額"]);
      return acc;
    }, {})
  ).map(({ _sumShip, _sumTotal, _sumLowerTotal, ...row }) => ({
    ...row,
    "出荷数": String(_sumShip),
    "合計金額": String(_sumTotal),
    "下代合計金額": String(_sumLowerTotal)
  }));
}
