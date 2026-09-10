function setButtonStyle(button, label, disabled = true, opacity = '0.6') {
	if (!button) return;
	button.innerText = label;
	button.disabled = disabled;
	button.style.opacity = opacity;
}

function getHeaderSpaceElement(event, page) {
	const isMobile = event.type.indexOf('mobile.') === 0;

	if (isMobile) {
		if (page === 'detail' && kintone.mobile.app.record && kintone.mobile.app.record.getHeaderSpaceElement) {
			return kintone.mobile.app.record.getHeaderSpaceElement();
		}
		return kintone.mobile.app.getHeaderSpaceElement();
	}

	if (page === 'detail' && kintone.app.record && kintone.app.record.getHeaderMenuSpaceElement) {
		return kintone.app.record.getHeaderMenuSpaceElement();
	}

	return kintone.app.getHeaderMenuSpaceElement() || kintone.app.getHeaderSpaceElement();
}

/**
 * ボタン設置
 * @param {string} id - ボタンのID
 * @param {string} label - ボタンのラベル
 * @param {function} callback - ボタンクリック時のコールバック関数
 * @param {boolean} reload - コールバック正常終了後にページをリロードするかどうか
 * @returns {void}
 */
function setButton(id, label, callback = () => {}, reload = false, page = 'index') {
	const eventTypes = [];
	switch (page) {
		case 'index':
			eventTypes.push('app.record.index.show', 'mobile.app.record.index.show');
			break;
		case 'detail':
			eventTypes.push('app.record.detail.show', 'mobile.app.record.detail.show');
			break;
		default:
			console.warn(`Unknown page value: ${page}`);
	}
	kintone.events.on(eventTypes, (event) => {
		try {
			const space = getHeaderSpaceElement(event, page);
			
			if (!space) {
				console.warn('ヘッダーのスペースが見つかりません。ボタンは追加されませんでした。');
				return event;
			}
			
			if (space.querySelector(`#${id}`)) {
				console.warn(`ボタン（ID: ${id}）は既に存在します。`);
				return event;
			}
			
			// ボタンの作成
			const button = document.createElement('button');
			button.id = id;
			button.innerText = label;
			button.className = 'kintoneplugin-button-normal';
			button.style.margin = '10px';
			
			// ボタンの設置
			space.appendChild(button);
			
			// ボタンのクリックイベントを設定
			button.addEventListener('click', async () => {
				const setLabel = (label) => setButtonStyle(button, label);
				try {
					await callback(setLabel);
					await setLabel('完了');
					alert('処理が完了しました。');
					if (reload) location.reload();
				} catch (e) {
					console.error(e);
					setLabel('エラー');
					alert(`エラー: ${e.message || e}`);
				} finally {
					setButtonStyle(button, label, false, '1.0'); // ボタンを元の状態に戻す
				}
			});
		} catch (e) {
			console.error('Failed to render button:', e);
		}
		return event;
	});
}
