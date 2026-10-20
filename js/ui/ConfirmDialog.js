/**
 * 간단한 확인/안내 대화상자 (사이트 테마에 맞춘 인라인 스타일, Promise 반환)
 *
 * showDialog({ title, lines, buttons: [{ id, label, primary }] }) → 누른 버튼 id (닫으면 null)
 * showFormDialog({ title, lines, fields: [{ name, label, type, value, placeholder, maxLength, options }], buttons })
 *   → { button, values } (닫으면 null). type: 'text' | 'url' | 'textarea' | 'select' | 'checkboxes'(값은 체크된 value 배열)
 */

export function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const INPUT_STYLE = 'width:100%;box-sizing:border-box;margin-top:4px;padding:9px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:#0f1724;color:#e8eef5;font-size:14px;font-family:inherit;';

function renderField(field) {
    const common = `name="${escapeHtml(field.name)}" placeholder="${escapeHtml(field.placeholder || '')}" style="${INPUT_STYLE}"`;
    let control;
    if (field.type === 'checkboxes') {
        control = `<div data-checkbox-group="${escapeHtml(field.name)}" style="max-height:260px;overflow-y:auto;margin-top:6px;">${(field.options || []).map(o => `
            <label style="display:flex;align-items:center;gap:8px;padding:6px 4px;color:${o.disabled ? '#6b7a8c' : '#e8eef5'};font-size:14px;">
                <input type="checkbox" value="${escapeHtml(o.value)}" ${o.disabled ? 'disabled' : ''} ${o.checked ? 'checked' : ''} style="width:16px;height:16px;margin:0;flex:0 0 auto;">
                ${escapeHtml(o.label)}
            </label>`).join('')}</div>`;
        return `<div style="margin:12px 0 0;font-size:13px;color:#9fb0c3;">${escapeHtml(field.label || '')}${control}</div>`;
    }
    if (field.type === 'textarea') {
        control = `<textarea ${common} rows="3" maxlength="${field.maxLength || 500}">${escapeHtml(field.value || '')}</textarea>`;
    } else if (field.type === 'select') {
        control = `<select ${common}>${(field.options || []).map(o =>
            `<option value="${escapeHtml(o.value)}" ${o.value === field.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`
        ).join('')}</select>`;
    } else {
        control = `<input type="${field.type === 'url' ? 'url' : 'text'}" ${common} maxlength="${field.maxLength || 200}" value="${escapeHtml(field.value || '')}">`;
    }
    return `<label style="display:block;margin:12px 0 0;font-size:13px;color:#9fb0c3;">${escapeHtml(field.label || '')}${control}</label>`;
}

function openDialog({ title, lines = [], fields = [], buttons = [] }, resolveValue) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:16px;';
        
        const box = document.createElement('div');
        box.style.cssText = 'background:#1a2332;color:#e8eef5;border:1px solid rgba(78,205,196,0.4);border-radius:12px;max-width:420px;width:100%;padding:22px 22px 18px;box-shadow:0 12px 40px rgba(0,0,0,0.5);font-family:inherit;';
        box.innerHTML = `
            <h3 style="margin:0 0 12px;font-size:18px;color:#4ecdc4;">${escapeHtml(title)}</h3>
            ${lines.map(line => `<p style="margin:6px 0;font-size:14px;line-height:1.5;">${escapeHtml(line)}</p>`).join('')}
            ${fields.map(renderField).join('')}
            <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:18px;"></div>
        `;
        const actions = box.lastElementChild;
        
        const close = (buttonId) => {
            const result = resolveValue(buttonId, box);
            overlay.remove();
            document.removeEventListener('keydown', onKey);
            resolve(result);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') close(null);
        };
        
        for (const button of buttons) {
            const el = document.createElement('button');
            el.textContent = button.label;
            el.style.cssText = button.primary
                ? 'background:#4ecdc4;color:#0a0a1a;border:none;border-radius:8px;padding:10px 16px;font-weight:700;cursor:pointer;font-size:14px;'
                : button.danger
                    ? 'background:transparent;color:#ff7b6b;border:1px solid rgba(255,123,107,0.5);border-radius:8px;padding:10px 16px;cursor:pointer;font-size:14px;'
                    : 'background:transparent;color:#cfd8e3;border:1px solid rgba(255,255,255,0.25);border-radius:8px;padding:10px 16px;cursor:pointer;font-size:14px;';
            el.onclick = () => close(button.id);
            actions.appendChild(el);
        }
        
        overlay.onclick = (e) => {
            if (e.target === overlay) close(null);
        };
        document.addEventListener('keydown', onKey);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        (box.querySelector('input, textarea, select') || actions.querySelector('button:last-child'))?.focus();
    });
}

export function showDialog(options) {
    return openDialog({ ...options, fields: [] }, (buttonId) => buttonId);
}

export function showFormDialog(options) {
    return openDialog(options, (buttonId, box) => {
        if (!buttonId) return null;
        const values = {};
        box.querySelectorAll('[name]').forEach(el => {
            values[el.getAttribute('name')] = el.value;
        });
        box.querySelectorAll('[data-checkbox-group]').forEach(group => {
            values[group.dataset.checkboxGroup] = [...group.querySelectorAll('input:checked')].map(input => input.value);
        });
        return { button: buttonId, values };
    });
}
