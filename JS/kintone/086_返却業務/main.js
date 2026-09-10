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
 * 取引先別返品明細出力ボタン設置
 */
setButton('outputCustomerReturnDetails', '取引先別返品明細出力', outputCustomerReturnDetails, false, 'index');

/**
 * 取引先別返品明細出力の出力
 */
async function outputCustomerReturnDetails(updateStatus) {
	/**
	 * １：返却業務（ZOZOからのデータ）
	 * で半年分や3ヶ月分とかのデータを取得
	 */
	const condition = await getFilterCondFromView(currentConfig.kintone.app['返却業務'].view['半年前～']);
	console.log('返却業務の条件:', condition);
	// const returnRecords = await fetchRecords('作成日時 >= FROM_TODAY(-3, MONTHS)');
	const returnRecords = await fetchRecords(condition);
	console.log('返却業務レコード:', returnRecords);
	
	/**
	 * 取得したデータから「未送信」のレコードを抽出
	 */
	const unsentRecords = returnRecords.filter(record => record['送信済みフラグ'].value === '送信中');	// '送信中' or '済' しかない
	console.log('未送信レコード:', unsentRecords);
	
	/**
	 * レコードにメーカーID/メーカー名がないのでCS品番からデータを差し込む
	 */
	// 商品マスタは膨大なので、CS品番の一覧を作って、商品マスタから一括で取得する
	const csNumbers = [...new Set(unsentRecords.map(record => record['CS別品番'].value))]; // CS品番のユニークな値の配列
	console.log('CS品番のユニークな値:', csNumbers);
	const csNumberCondition = `CS別品番 in ("${csNumbers.join('","')}")`;
	const productMasterRecords = await fetchRecordsFromApp(
		currentConfig.kintone.app['商品マスタ'].api_token,
		currentConfig.kintone.app['商品マスタ'].id,
		currentConfig.kintone.app['商品マスタ'].view['CS品番'],
		`${csNumberCondition}`
	);
	console.log('商品マスタレコード:', productMasterRecords);
	
	// 商品マスタのデータを使って、返却業務のレコードにメーカーID/メーカー名を差し込む
	const productMap = new Map(productMasterRecords.map(record => [record['CS別品番'].value, record]));
	unsentRecords.forEach(record => {
		const productRecord = productMap.get(record['CS別品番'].value);
		if (productRecord) {
			record['メーカーID'] = { type: 'NUMBER', value: productRecord['登録メーカーID'].value };
			record['メーカー名'] = { type: 'SINGLE_LINE_TEXT', value: productRecord['メーカー名'].value };
		}
	});
	console.log('メーカーID/メーカー名を差し込んだ未送信レコード:', unsentRecords);
	
	/**
	 * かつそのレコード内のユニークキーにて「3ヶ月分レコード」内に既に「送信済み」となってるレコードが無いかチェック
	 * キー＝「返却番号＋CS品番」
	 */
	// レコードに 'キー' (※返却番号＋CS品番) が存在するのでそれでグルーピングする
	const keyGroupedRecords = unsentRecords.reduce((acc, record) => {
		const key = record['キー'].value;
		if (!acc[key]) {
			acc[key] = [];
		}
		acc[key].push(record);
		return acc;
	}, {});
	console.log('キーでグルーピングされたレコード:', keyGroupedRecords);
	console.log('keyGroupedRecordsの数:', Object.keys(keyGroupedRecords).length);

	// keyGroupedRecordsに、複数のレコードが存在するキーが存在するか確認
	const keysWithMultipleRecords = Object.keys(keyGroupedRecords).filter(key => keyGroupedRecords[key].length > 1);
	console.log('複数のレコードが存在するキー:', keysWithMultipleRecords);
	// キーがKintone上でユニーク設定なので、キーが同じで別のレコード存在しえないのでは? 要確認
	
	// キーが重複するとして、以下の分類で配列を作る
	// 1. 明細に積んで、レコードを更新しないグールプ : 配送伝票番号が未登録のレコードしかないキー
	// 2. 明細に積んで、レコードを更新するグループ : 伝票番号に数値が登録されている + 未送信レコードがしかないキー
	// 3. 明細から外して、レコードを更新するグループ : 伝票番号に数値が登録されている + 送信済みレコードがあるキー
	
	const immutableRecords = [];	// 1. 明細に積んで、レコードを更新しないグールプ
	const updateSendRecords = [];	// 2. 明細に積んで、レコードを更新するグループ
	const updateSentRecords = [];	// 3. 明細から外して、レコードを更新するグループ
	// キーごとに分類する
	for (const key in keyGroupedRecords) {
		const records = keyGroupedRecords[key];
		const hasSentRecord = records.some(record => record['送信済みフラグ'].value === '済');
		const hasUndeliveredRecord = records.every(record => record['配送伝票番号'].value && isNaN(record['配送伝票番号'].value)); // 配送伝票番号が数値以外のレコードだけか
		const hasDeliveredRecord = records.some(record => record['配送伝票番号'].value && !isNaN(record['配送伝票番号'].value)); // 配送伝票番号が数値のレコードがあるか
		/*
		// 配送伝票番号が数値ではないレコードの内容を確認
		const nonNumericDeliveryRecords = records.filter(record => record['配送伝票番号'].value && isNaN(record['配送伝票番号'].value)); // 配送伝票番号が数値ではないレコード
		if (nonNumericDeliveryRecords.length > 0) {
			console.log('配送伝票番号が数値ではないレコード:', nonNumericDeliveryRecords);
		}
		*/
		if (hasUndeliveredRecord) {
			immutableRecords.push(...records);
		} else if (!hasSentRecord && hasDeliveredRecord) {
			updateSendRecords.push(...records);
		} else if (hasSentRecord && hasDeliveredRecord) {
			updateSentRecords.push(...records);
		}
	}
	console.log('明細に積んで、レコードを更新しないグールプ:', immutableRecords);
	console.log('明細に積んで、レコードを更新するグループ:', updateSendRecords);
	console.log('明細から外して、レコードを更新するグループ:', updateSentRecords);
	
	/**
	 * メーカー毎に処理する
	 */
	// keyGroupedRecordsからメーカーID一覧を取得
	const manufacturerIds = [...new Set(unsentRecords.map(record => record['メーカーID'].value))];
	console.log('メーカーID一覧:', manufacturerIds);
	for (const manufacturerId of manufacturerIds) {
		// メーカーIDに紐づくレコードを抽出
		const recordsForManufacturer = unsentRecords.filter(record => record['メーカーID'].value === manufacturerId);
		console.log(`メーカーID ${manufacturerId} に紐づくレコード:`, recordsForManufacturer);
	}
	
	/*
　　１a：キーで送信済みなし：配送伝票番号＝未配送だったら　→　返品明細に加える、送信済フラグ＝未送信＝次回もメール送信対象
　　１b：キーで送信済みあり：配送伝票番号＝未配送だったら　→　返品明細に加える、送信済フラグ＝未送信＝次回もメール送信対象

　　２a：キーで送信済みなし：配送伝票番号＝数値だったら　　→　返品明細に加える、送信済フラグ＝完了　&メール送信（GMAIL手作業）　次回は返却リスト対象外
　　２b：キーで送信済みあり：配送伝票番号＝数値だったら　　→　返品明細に加えない、送信済フラグは立てる。


	出力単位：メーカー単位
・返却業務：（条件：送信済フラグが未送信）VIEWID 5522503
・親カテゴリマスタ：親カテゴリ名in(親カテゴリ) ※メーカーIDを取得
・メーカーマスタ　メーカーID in(親カテゴリマスタ.メーカーID)　連絡先を取得

	*/
}
