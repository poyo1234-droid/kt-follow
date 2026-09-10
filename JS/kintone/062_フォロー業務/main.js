'use strict';
// NEED: config.js
// NEED: GoogleAPIFunctions.js
// NEED: KintoneAPIFunctions.js
// NEED: ui.js

const currentConfig = window.config.production;

setButton('followListOutput', 'フォローリスト出力', executeFollowUpDataFetch, true, 'detail');
async function executeFollowUpDataFetch(updateStatus = () => {}) {
  try {
    const config = currentConfig.kintone.app;
    
    // ----------------------------------------------------
    // 0. 開いている「フォロー業務」レコードからパラメータを取得
    // ----------------------------------------------------
    const currentRecordObj = kintone.app.record.get();
    if (!currentRecordObj || !currentRecordObj.record) {
      throw new Error('レコード情報が取得できませんでした。詳細画面から実行してください。');
    }
    const currentRecord = currentRecordObj.record;
    
    const followStartDate = currentRecord['フォロー開始日']?.value;
    
    if (!followStartDate) {
      throw new Error('エラー: 「フォロー開始日」が設定されていません。');
    }
    
    // 親フォルダIDは config から取得
    const targetFolderId = currentConfig.google.drive['フォロー業務'].target_folder_id;
    if (!targetFolderId) {
      throw new Error('エラー: config.js の google.drive.フォロー業務.target_folder_id が設定されていません。');
    }

    // ----------------------------------------------------
    // 1. 各種データの一括事前ロード（取引先別売上精算書出力と同様の構成）
    // ----------------------------------------------------
    // (1) 商品マスタ（販売中の商品）を一括取得
    updateStatus('商品マスタ（販売中の商品）取得中...');
    const allActiveProducts = await fetchRecordsFromApp(
      config['商品マスタ'].api_token,
      config['商品マスタ'].id,
      config['商品マスタ'].view['販売中の商品']
    );
    
    if (!allActiveProducts || allActiveProducts.length === 0) {
      throw new Error('販売中の商品が見つかりませんでした。');
    }

    // (2) 絞り込み用の各種キーの抽出（前後のスペースや改行を除去）
    const csCodes = [...new Set(allActiveProducts.map(r => r['CS別品番']?.value?.trim()?.replace(/\r?\n/g, '')).filter(Boolean))];
    const brandCodes = [...new Set(allActiveProducts.map(r => r['ブランド品番']?.value?.trim()?.replace(/\r?\n/g, '')).filter(Boolean))];
    const makerIds = [...new Set(allActiveProducts.map(r => (r['メーカーID']?.value || r['登録メーカーID']?.value)?.trim()?.replace(/\r?\n/g, '')).filter(Boolean))];

    // (3) 各種データの一括ロード（在庫・在庫分析・salegoods・発注明細は全件一括ロード）
    
    // (A) 在庫データの全件一括ロード
    updateStatus('在庫データ取得中...');
    const clientInv = new KintoneRestAPIClient({ auth: { apiToken: config['在庫'].api_token } });
    const allInventoryData = await clientInv.record.getAllRecords({ app: config['在庫'].id });

    // (B) 在庫分析データの全件一括ロード
    updateStatus('在庫分析データ取得中...');
    const clientAnalysis = new KintoneRestAPIClient({ auth: { apiToken: config['在庫分析'].api_token } });
    const allInventoryAnalysisData = await clientAnalysis.record.getAllRecords({ app: config['在庫分析'].id });

    // (C) salegoodsデータの全件一括ロード
    updateStatus('salegoodsデータ取得中...');
    const clientSale = new KintoneRestAPIClient({ auth: { apiToken: config['salegoods'].api_token } });
    const allSaleGoodsData = await clientSale.record.getAllRecords({ app: config['salegoods'].id });

    // (D) メーカーマスタ & 親カテゴリマスタの一括ロード（ビュー条件の動的 and 結合）
    updateStatus('メーカーマスタおよび親カテゴリマスタ取得中...');
    let makerQuery = makerIds.length > 0 ? `メーカーID in (${makerIds.map(v => '"' + String(v).replace(/"/g, '\\"') + '"').join(',')})` : '';
    if (makerQuery) {
      const v = await (new KintoneRestAPIClient({ auth: { apiToken: config['メーカーマスタ from SQL'].api_token } })).app.getViews({ app: config['メーカーマスタ from SQL'].id });
      if (Object.values(v.views).find(w => w.id === config['メーカーマスタ from SQL'].view['連絡先'])?.filterCond) makerQuery = ' and ' + makerQuery;
    }
    const allManufacturers = await fetchRecordsFromApp(
      config['メーカーマスタ from SQL'].api_token,
      config['メーカーマスタ from SQL'].id,
      config['メーカーマスタ from SQL'].view['連絡先'],
      makerQuery
    );
    
    let parentQuery = makerIds.length > 0 ? `メーカーコード in (${makerIds.map(v => '"' + String(v).replace(/"/g, '\\"') + '"').join(',')})` : '';
    if (parentQuery) {
      const v = await (new KintoneRestAPIClient({ auth: { apiToken: config['親カテゴリマスタ'].api_token } })).app.getViews({ app: config['親カテゴリマスタ'].id });
      if (Object.values(v.views).find(w => w.id === config['親カテゴリマスタ'].view['連絡先'])?.filterCond) parentQuery = ' and ' + parentQuery;
    }
    const allParentCategories = await fetchRecordsFromApp(
      config['親カテゴリマスタ'].api_token,
      config['親カテゴリマスタ'].id,
      config['親カテゴリマスタ'].view['連絡先'],
      parentQuery
    );

    // (D-2) 子カテゴリマスタの一括ロード
    updateStatus('子カテゴリマスタ取得中...');
    const clientSubCategory = new KintoneRestAPIClient({ auth: { apiToken: config['子カテゴリマスタ'].api_token } });
    const allSubCategories = await clientSubCategory.record.getAllRecords({ app: config['子カテゴリマスタ'].id });

    // (E) 発注明細の全件一括ロード
    updateStatus('発注明細取得中...');
    const clientDetail = new KintoneRestAPIClient({ auth: { apiToken: config['発注明細'].api_token } });
    const allOrderDetails = await clientDetail.record.getAllRecords({ app: config['発注明細'].id });
    
    // (8) Googleアクセストークンの取得
    updateStatus('Googleアクセストークン取得中...');
    let accessToken = await getAccessToken();
    
    // (9) Google Drive上での日付フォルダ（yyyy/mm/dd）の作成 (指定された親フォルダ配下)
    const templateSpreadsheetId = currentConfig.google.drive['フォロー業務'].template_spreadsheet_id;
    
    const today = new Date();
    const formattedDateSlash = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
    const formattedDateNoSlash = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    
    updateStatus(`日付フォルダ（${formattedDateSlash}）作成中...`);
    const dateFolder = await createDriveFolder(accessToken, targetFolderId, formattedDateSlash);
    const dateFolderId = dateFolder.id;
    const dateFolderUrl = dateFolder.webViewLink;

    // 現在開いているフォロー業務レコードの「フォローリストフォルダ」フィールドを作成したフォルダのURLで更新
    updateStatus('レコードのフォルダURLを更新中...');
    const recordId = kintone.app.record.getId();
    const updateRecordBody = {
      app: kintone.app.getId(),
      id: recordId,
      record: {
        "フォローリストフォルダ": { value: dateFolderUrl || dateFolderId }
      }
    };
    await kintone.api(kintone.api.url('/k/v1/record.json', true), 'PUT', updateRecordBody);
    
    // 1.5 各種データの検索用インデックス（Map）を作成
    const subCategoryMapById = {};
    allSubCategories.forEach(sub => {
      const subId = sub['子カテゴリID']?.value?.trim();
      if (subId) {
        subCategoryMapById[subId] = sub;
      }
    });

    // 親カテゴリマスタのインデックス（キー: 親子複合コード）
    const parentCategoryMapByCompositeKey = {};
    allParentCategories.forEach(pc => {
      const compKey = pc['親子複合コード']?.value?.trim();
      if (compKey) {
        parentCategoryMapByCompositeKey[compKey] = pc;
      }
    });

    // ----------------------------------------------------
    // 2. 取得した「販売中の商品」をグループ化（出力単位に応じてメーカー単位 or 親カテゴリ単位）
    // ----------------------------------------------------
    const productsByGroup = {};
    const groupMeta = {}; // 各グループのメタ情報
    
    allActiveProducts.forEach(product => {
      const makerCode = (product['メーカーID']?.value || product['登録メーカーID']?.value || '')?.trim()?.replace(/\r?\n/g, '');
      if (!makerCode) return; // 不明なものはスキップ
      
      // 商品マスタの子カテゴリID（または子カテゴリコード）を取得し、子カテゴリマスタから親子複合コードを特定
      const childCategoryId = (product['子カテゴリID']?.value || product['子カテゴリコード']?.value || product['子カテゴリ']?.value || '')?.trim();
      const subCategory = subCategoryMapById[childCategoryId];
      const compositeKey = subCategory?.['親子複合コード']?.value?.trim() || '';

      // 親子複合コードをキーに親カテゴリマスタから正確なレコードを取得
      const parentCategoryRecord = (compositeKey && (parentCategoryMapByCompositeKey[compositeKey] || allParentCategories.find(pc => pc['親子複合コード']?.value == compositeKey)))
        || allParentCategories.find(pc => pc['メーカーコード']?.value == makerCode);

      const mId = parentCategoryRecord?.['メーカーID']?.value || makerCode;
      const makerRecord = allManufacturers.find(m => m['メーカーID']?.value == mId);
      
      // 出力単位の判定（デフォルトは親カテゴリ）
      const outputUnit = makerRecord?.['フォローリスト出力単位']?.value || '親カテゴリ';
      
      // 出力単位が「親カテゴリ」の場合は「親子複合コード」、出力単位が「メーカー」の場合は「メーカーID」とする
      const groupKey = outputUnit === 'メーカー' ? mId : (compositeKey || `${makerCode}_unknown`);
      
      if (!productsByGroup[groupKey]) {
        productsByGroup[groupKey] = [];
        groupMeta[groupKey] = {
          outputUnit,
          makerId: mId,
          makerCode,
          compositeKey,
          makerRecord,
          parentCategoryRecord
        };
      }
      productsByGroup[groupKey].push(product);
    });
    
    // ----------------------------------------------------
    // 3. グループごとのループ処理
    // ----------------------------------------------------
    const groupKeys = Object.keys(productsByGroup);
    const totalGroups = groupKeys.length;
    
    let successCount = 0;
    let failCount = 0;
    const failedManufacturers = [];
    
    for (let i = 0; i < totalGroups; i++) {
      const groupKey = groupKeys[i];
      const activeProducts = productsByGroup[groupKey];
      const meta = groupMeta[groupKey];
      
      const makerRecord = meta.makerRecord;
      const parentCategoryRecord = meta.parentCategoryRecord;
      
      const makerName = meta.outputUnit === 'メーカー'
        ? (makerRecord?.['メーカー名']?.value || activeProducts[0]['メーカー名']?.value || 'メーカー不明')
        : (parentCategoryRecord?.['親カテゴリ名']?.value || parentCategoryRecord?.['親カテゴリ']?.value || parentCategoryRecord?.['親カテゴリー名']?.value || parentCategoryRecord?.['メーカー名']?.value || activeProducts[0]['メーカー名']?.value || 'メーカー不明');
      
      const progressLabel = `(${i + 1}/${totalGroups}) ${makerName}`;
      updateStatus('処理中... ' + progressLabel);
      console.log(`--- [メーカー処理開始] ${progressLabel} ---`);
      
      const maxRetries = 2; // 最初の試行(1) + 自動リトライ(1)
      let attempt = 0;
      let isSuccess = false;
      
      while (attempt < maxRetries && !isSuccess) {
        attempt++;
        try {
          accessToken = await getAccessToken();

          const currentCsCodes = [...new Set(activeProducts.map(r => r['CS別品番']?.value?.trim()?.replace(/\r?\n/g, '')).filter(Boolean))];
          const currentBrandCodes = [...new Set(activeProducts.map(r => r['ブランド品番']?.value?.trim()?.replace(/\r?\n/g, '')).filter(Boolean))];
          
          if (currentCsCodes.length === 0) {
            isSuccess = true;
            continue;
          }
          
          // ① 各種詳細データをメモリ上のデータから抽出（このメーカーの品番のみで絞り込み）
          const inventoryData = allInventoryData.filter(inv => {
            const val = inv['CS品番']?.value?.trim()?.replace(/\r?\n/g, '');
            return val && currentCsCodes.includes(val);
          });
          const inventoryAnalysisData = allInventoryAnalysisData.filter(an => {
            const val = an['CS品番']?.value?.trim()?.replace(/\r?\n/g, '');
            return val && currentCsCodes.includes(val);
          });
          const saleGoodsData = allSaleGoodsData.filter(sg => {
            const val = sg['ブランド品番']?.value?.trim()?.replace(/\r?\n/g, '');
            return val && currentBrandCodes.includes(val);
          });
          const orderDetails = allOrderDetails.filter(od => {
            const val = od['CS品番']?.value?.trim()?.replace(/\r?\n/g, '');
            return val && currentCsCodes.includes(val);
          });
          
          // 直近10日間の発注数集計 (CS品番ごと)
          const orderSummaryByCs = {};
          orderDetails.forEach(record => {
            const csCode = record['CS品番']?.value;
            const quantity = Number(record['ZOZO納品数量']?.value || 0);
            if (csCode) {
              orderSummaryByCs[csCode] = (orderSummaryByCs[csCode] || 0) + quantity;
            }
          });
          
          // (3) Excel書き込み用データの整形と流し込み
          const excelRows = activeProducts.map(product => {
            const csCode = product['CS別品番']?.value;
            const inventory = inventoryData.find(inv => inv['CS品番']?.value === csCode);
            const analysis = inventoryAnalysisData.find(an => an['CS品番']?.value === csCode);
            const recentOrderQty = orderSummaryByCs[csCode] || 0;
            
            return [
              product['商品名']?.value || '',                               // A: 商品名
              product['ブランド品番']?.value || '',                           // B: ブランド品番
              product['CS別品番']?.value || '',                             // C: CS別品番
              product['カラーコード']?.value || '',                          // D: ZOZOカラー名
              product['カラー名称']?.value || '',                            // E: メーカーカラー名
              product['メーカーサイズ']?.value || '',                         // F: サイズ名
              inventory?.['プロパー価格_税抜_']?.value || '',               // G: 元上代
              inventory?.['販売価格_税抜_']?.value || '',                   // H: 販売価格
              inventory?.['価格タイプ']?.value || '',                       // I: 価格タイプ
              analysis?.['販売タイプ']?.value || '',                        // J: 販売タイプ
              inventory?.['在庫数']?.value || '',                           // K: 在庫数量
              analysis?.['販売可能数']?.value || '',                        // L: 販売可能数
              analysis?.['直近7日販売数']?.value || '',                     // M: 直近7日販売数量
              analysis?.['直近30日販売数']?.value || '',                    // N: 直近30日販売数量
              '',                                                           // O: フォロー希望数 (空欄)
              '',                                                           // P: フォロー可能数 (空欄)
              recentOrderQty,                                               // Q: 直近10日間の発注数
              analysis?.['最終入荷日からの経過日数']?.value || '',          // R: 最終入荷日からの経過日数
              analysis?.['お気に入り登録数']?.value || '',                  // S: お気に入り登録数
              product['JANコード']?.value || ''                              // T: JANコード
            ];
          });
          
          // (4) テンプレートSpreadsheetのコピーを作成と流し込み
          let displayName = '';
          const companyName = makerRecord?.['メーカー名']?.value || parentCategoryRecord?.['メーカー名']?.value || activeProducts[0]['メーカー名']?.value || makerName;
          if (meta.outputUnit === 'メーカー') {
            displayName = `${companyName}様`;
          } else {
            // 親カテゴリ単位の場合は「会社名_ブランド名様」とする
            const pName = parentCategoryRecord?.['親カテゴリ名']?.value || parentCategoryRecord?.['親カテゴリ']?.value || parentCategoryRecord?.['親カテゴリー名']?.value || '';
            displayName = pName ? `${companyName}_${pName}様` : `${companyName}様`;
          }
          const fileName = `${meta.makerId}_${displayName}_フォローリスト_${formattedDateNoSlash}`;
          
          const copiedSpreadsheet = await copyDriveFile(
            accessToken,
            templateSpreadsheetId,
            fileName,
            dateFolderId,
            'application/vnd.google-apps.spreadsheet'
          );
          
          await updateSpreadsheetValues(
            accessToken,
            copiedSpreadsheet.id,
            'A2', // A2セルから書き込みを開始
            excelRows,
            { sheetName: 'テンプレート', valueInputOption: 'USER_ENTERED', majorDimension: 'ROWS' }
          );
          
          // (5) Excelファイルに変換してKintoneへアップロード・追加
          const exportedXlsxBlob = await exportSpreadsheetAsXlsx(accessToken, copiedSpreadsheet.id);
          const exportedXlsxFileName = `${fileName}.xlsx`;
          const exportedXlsxFileKey = await uploadFileToKintone(exportedXlsxBlob, exportedXlsxFileName);
          
          // 各種宛先情報の抽出（連絡先テーブルから宛先種別に応じてTO, CC, BCCを抽出）
          const targetRecord = meta.outputUnit === 'メーカー' ? makerRecord : parentCategoryRecord;
          

          
          let nameTo = [];
          let mailTo = [];
          let nameCc = [];
          let mailCc = [];
          
          if (targetRecord && targetRecord['連絡先']?.value && targetRecord['連絡先'].value.length > 0) {
            const contacts = targetRecord['連絡先'].value;
            
            // TO
            contacts.filter(item => item.value['宛先種別']?.value?.includes("フォロー（TO）")).forEach(item => {
              nameTo.push(item.value['担当者名']?.value || '');
              mailTo.push(item.value['メールアドレス']?.value || '');
            });
            // CC
            contacts.filter(item => item.value['宛先種別']?.value?.includes("フォロー（CC）")).forEach(item => {
              nameCc.push(item.value['担当者名']?.value || '');
              mailCc.push(item.value['メールアドレス']?.value || '');
            });
          }
          
          const recipientToName = nameTo.filter(Boolean).join(',');
          const recipientToEmail = mailTo.filter(Boolean).join(',');
          const recipientCcName = nameCc.filter(Boolean).join(',');
          const recipientCcEmail = mailCc.filter(Boolean).join(',');

          const appId = config['フォローリスト'].id;
          const requestBody = {
            app: appId,
            record: {
              "メーカーID": { value: meta.makerId },
              "メーカー名": { value: makerName },
              "フォロー開始日": { value: followStartDate },
              "担当者名_TO": { value: recipientToName },
              "メール宛先_TO": { value: recipientToEmail },
              "担当者名_CC": { value: recipientCcName },
              "メール宛先_CC": { value: recipientCcEmail },
              "フォローリスト": { value: [{ fileKey: exportedXlsxFileKey }] }
            }
          };
          await addAppRecord(requestBody);
          
          isSuccess = true;
          successCount++;
          console.log(`--- [メーカー処理完了] ${progressLabel} ---`);
          
          // Google API への連続アクセス（レート制限）を和らげるためのウェイト（500ms）
          await new Promise(resolve => setTimeout(resolve, 500));
          
        } catch (makerError) {
          console.error(`【デバッグエラー】メーカー「${makerName}」の試行 ${attempt} 回目でエラーが発生しました。`, makerError);
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 3000)); // 3秒待機してリトライ
          } else {
            failCount++;
            failedManufacturers.push(makerName);
            console.error(`【エラー発生】メーカー「${makerName}」の処理中にエラーが発生しました。スキップします。`, makerError);
          }
        }
      }
    }
    
    if (failCount > 0) {
      updateStatus(`処理完了（成功: ${successCount}件, 失敗: ${failCount}件）。詳細はコンソールログを確認してください。`);
      console.warn('処理に失敗したメーカー一覧:', failedManufacturers);
    } else {
      updateStatus('すべてのフォローリスト出力が完了しました！');
    }
    
  } catch (error) {
    updateStatus('エラーが発生しました。');
    console.error('処理中に失敗しました。', error);
    let detailMsg = error.message || '不明なエラー';
    if (error.results) {
      const details = Object.entries(error.results).map(([key, val]) => {
        return `${key}: ${val.error || JSON.stringify(val)}`;
      }).join('\n');
      detailMsg += '\n【詳細】\n' + details;
    } else if (error.errors) {
      const details = Object.entries(error.errors).map(([key, val]) => {
        return `${key}: ${val.messages ? val.messages.join(', ') : JSON.stringify(val)}`;
      }).join('\n');
      detailMsg += '\n【詳細】\n' + details;
    }
    throw new Error(detailMsg);
  }
}
