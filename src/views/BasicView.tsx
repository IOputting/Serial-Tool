import React, { useState, useEffect, useRef, memo, forwardRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save, open } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { useSerialStore, QuickCommand, LogEntry } from "../stores/useSerialStore";
import { Virtuoso } from 'react-virtuoso';

type SendMode = 'ascii' | 'hex' | 'timed' | 'file';

// ==========================================
// 全局样式与类型定义
// ==========================================
const COMMON_FONT = "'Cascadia Code', Consolas, 'Microsoft YaHei', 'PingFang SC', monospace";

interface ExecuteSend {
  (text: string, isHex: boolean, appendCrlf: boolean): Promise<boolean> | boolean;
}

// ==========================================
// 1. 独立日志行组件 (CSS Hover 性能优化版)
// ==========================================
const LogRow = memo(({ log, showInvisible }: { log: LogEntry, showInvisible: boolean }) => {
  const renderText = useCallback((text: string, isHex: boolean) => {
    if (!isHex && showInvisible) return text.replace(/\r/g, '\\r').replace(/\n/g, '\\n\n').replace(/\0/g, '\\0');
    if (!isHex) return text.replace(/\r/g, ''); 
    return text;
  }, [showInvisible]);

  const { color, prefix } = React.useMemo(() => {
    if (log.type === 'send') return { color: "#40a9ff", prefix: "-> " };
    if (log.type === 'recv') return { color: "#73d13d", prefix: "<- " };
    return { color: "#ffc53d", prefix: "SYS " };
  }, [log.type]);

  return (
    // 使用 className "log-row" 配合 CSS 实现 hover，取代 React State，大幅提升虚拟列表性能
    <div className="log-row" style={{ color }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {!log.isContinuous && (
          <div className="log-header">
            <span className="no-copy-text" data-content={`[${log.time}] `} style={{ color: "#777", marginRight: "4px" }}></span>
            <span className="no-copy-text" data-content={prefix}></span>
          </div>
        )}
        <div style={{ padding: "0 15px" }}>
          {renderText(log.text, log.isHex)}
        </div>
      </div>
      <div 
        className="no-copy-text log-time" 
        data-content={log.time}
        style={{ paddingTop: log.isContinuous ? "0px" : "20px" }}
      ></div>
    </div>
  );
}, (prev, next) => prev.log.id === next.log.id && prev.showInvisible === next.showInvisible);


// ==========================================
// 2. 底层 DOM 历史记录 Hook (增加组件卸载清理)
// ==========================================
function useEditorHistory(textareaRef: React.RefObject<HTMLTextAreaElement | null>, onChangeCallback: () => void) {
  const history = useRef({ past: [] as any[], future: [] as any[], current: { val: '', cursor: 0 }, timer: null as number | null });

  // 清理副作用
  useEffect(() => {
    return () => {
      if (history.current.timer) window.clearTimeout(history.current.timer);
    };
  }, []);

  const setNativeValue = useCallback((val: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    valueSetter ? valueSetter.call(el, val) : el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, [textareaRef]);

  const commit = useCallback((val: string, cursor: number) => {
    const st = history.current;
    if (st.current.val !== val) {
      st.past.push({ ...st.current });
      if (st.past.length > 50) st.past.shift();
      st.future = [];
      st.current = { val, cursor };
    }
  }, []);

  const executeChange = useCallback((newVal: string, newCursor: number) => {
    const el = textareaRef.current;
    if (!el) return;
    if (history.current.timer) window.clearTimeout(history.current.timer);
    if (el.value !== history.current.current.val) commit(el.value, el.selectionStart);
    
    setNativeValue(newVal);
    el.selectionStart = el.selectionEnd = newCursor;
    commit(newVal, newCursor);
    onChangeCallback();
  }, [commit, onChangeCallback, setNativeValue, textareaRef]);

  const triggerInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (history.current.timer) window.clearTimeout(history.current.timer);
    history.current.timer = window.setTimeout(() => commit(el.value, el.selectionStart), 400);
    onChangeCallback();
  }, [commit, onChangeCallback, textareaRef]);

  const undo = useCallback(() => {
    const st = history.current; const el = textareaRef.current;
    if (!el) return;
    if (st.timer) window.clearTimeout(st.timer);
    if (el.value !== st.current.val) {
      st.past.push({ ...st.current });
      st.current = { val: el.value, cursor: el.selectionStart };
    }
    if (st.past.length === 0) return;
    const prev = st.past.pop()!;
    st.future.push({ ...st.current });
    st.current = prev;
    
    setNativeValue(prev.val);
    el.selectionStart = el.selectionEnd = prev.cursor;
    el.focus();
    onChangeCallback();
  }, [onChangeCallback, setNativeValue, textareaRef]);

  const redo = useCallback(() => {
    const st = history.current; const el = textareaRef.current;
    if (!el) return;
    if (st.timer) window.clearTimeout(st.timer);
    if (el.value !== st.current.val) commit(el.value, el.selectionStart);
    if (st.future.length === 0) return;
    const next = st.future.pop()!;
    st.past.push({ ...st.current });
    st.current = next;
    
    setNativeValue(next.val);
    el.selectionStart = el.selectionEnd = next.cursor;
    el.focus();
    onChangeCallback();
  }, [commit, onChangeCallback, setNativeValue, textareaRef]);

  return { triggerInput, undo, redo, executeChange };
}

// ==========================================
// 3. 完美虚拟占位符的只读外壳组件 (完善类型)
// ==========================================
interface SmartInputProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  placeholderText: string;
  isDisabled: boolean;
}

const SmartInput = forwardRef<HTMLTextAreaElement, SmartInputProps>(
  ({ placeholderText, isDisabled, onInput, ...props }, ref) => {
    const [isEmpty, setIsEmpty] = useState(true);

    return (
      <div className="smart-input-container">
        {isEmpty && <div className="smart-input-placeholder">{placeholderText}</div>}
        <textarea
          ref={ref}
          disabled={isDisabled}
          onInput={(e) => {
            setIsEmpty((e.target as HTMLTextAreaElement).value.length === 0);
            onInput?.(e);
          }}
          className={`smart-input-textarea ${isDisabled ? 'disabled' : ''}`}
          {...props}
        />
      </div>
    );
  }
);


// ==========================================
// 4. 发送控制面板 (逻辑解耦与可读性优化)
// ==========================================
const SendControlPanel = memo(({ isConnected, executeSend }: { isConnected: boolean, executeSend: ExecuteSend }) => {
  const [sendMode, setSendMode] = useState<SendMode>('ascii');
  const [appendCrlf, setAppendCrlf] = useState(true);
  const [clearAfterSend, setClearAfterSend] = useState(true); 
  const [timerInterval, setTimerInterval] = useState(1000);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [timedIsHex, setTimedIsHex] = useState(false); 
  const [selectedFilePath, setSelectedFilePath] = useState("");
  
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([]);
  const [suggestions, setSuggestions] = useState<QuickCommand[]>([]);
  const [suggestionIdx, setSuggestionIdx] = useState(0);

  const commandHistoryRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(0);
  const currentDraftRef = useRef<string>("");
  const timerRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const checkSuggestions = useCallback(() => {
    if (!textareaRef.current) return;
    const val = textareaRef.current.value; 
    const currentWord = val.substring(0, textareaRef.current.selectionStart).split(/\s+/).pop() || "";
    
    if (currentWord.length > 0) {
      setSuggestions(quickCommands.filter(c => c.data.toLowerCase().startsWith(currentWord.toLowerCase()))); 
      setSuggestionIdx(0);
    } else {
      setSuggestions([]); 
    }
  }, [quickCommands]);

  const editor = useEditorHistory(textareaRef, checkSuggestions);

  const stopTimer = useCallback(() => { 
    if (timerRef.current) clearInterval(timerRef.current); 
    setIsTimerRunning(false); 
  }, []);

  useEffect(() => {
    if ((!isConnected || sendMode !== 'timed') && isTimerRunning) stopTimer();
    return () => stopTimer();
  }, [isConnected, sendMode, isTimerRunning, stopTimer]);

  const startTimer = useCallback(() => {
    const textToSend = textareaRef.current?.value || "";
    if (!isConnected || !textToSend) return alert("连接未就绪或数据为空！");
    if (timerInterval < 10) return alert("定时时间不能小于 10ms");
    
    setIsTimerRunning(true); 
    executeSend(textToSend, timedIsHex, appendCrlf && !timedIsHex); 
    timerRef.current = window.setInterval(() => executeSend(textToSend, timedIsHex, appendCrlf && !timedIsHex), timerInterval);
  }, [isConnected, timerInterval, executeSend, timedIsHex, appendCrlf]);

  const handleMainSendAction = useCallback(async () => {
    if (sendMode === 'file') {
      if (!isConnected) return alert("请先连接串口！");
      if (!selectedFilePath) return alert("请先选择要发送的文件！");
      try { 
        await invoke("send_file", { filePath: selectedFilePath }); 
      } catch (e) { 
        alert("启动文件发送失败: " + e); 
      }
    } else if (sendMode === 'timed') {
      isTimerRunning ? stopTimer() : startTimer();
    } else {
      const textToSend = textareaRef.current?.value || "";
      const isHex = sendMode === 'hex';
      
      if (await executeSend(textToSend, isHex, appendCrlf && !isHex)) {
        if (textToSend.trim() !== "") {
          const hist = commandHistoryRef.current;
          if (hist.length === 0 || hist[hist.length - 1] !== textToSend) {
            hist.push(textToSend);
          }
          historyIndexRef.current = hist.length;
          currentDraftRef.current = "";
        }

        if (clearAfterSend) { 
          editor.executeChange("", 0);
          setSuggestions([]); 
        }
        setTimeout(() => textareaRef.current?.focus(), 50);
      }
    }
  }, [sendMode, isConnected, selectedFilePath, isTimerRunning, stopTimer, startTimer, executeSend, appendCrlf, clearAfterSend, editor]);

  const applySuggestion = useCallback((selected: QuickCommand) => {
    if (!textareaRef.current) return;
    const target = textareaRef.current; 
    const textBeforeCursor = target.value.substring(0, target.selectionStart);
    const currentWord = textBeforeCursor.split(/\s+/).pop() || "";
    const newTextBefore = textBeforeCursor.substring(0, textBeforeCursor.length - currentWord.length) + selected.data;
    
    editor.executeChange(newTextBefore + target.value.substring(target.selectionStart), newTextBefore.length);
    setSuggestions([]);
    setTimeout(() => target.focus(), 0);
  }, [editor]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const modifier = e.ctrlKey || e.metaKey;
    if (modifier && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); editor.undo(); return; }
    if ((modifier && e.key.toLowerCase() === 'y') || (modifier && e.shiftKey && e.key.toLowerCase() === 'z')) { e.preventDefault(); editor.redo(); return; }

    if (suggestions.length > 0) {
      if (e.key === 'Tab' || (e.key === 'Enter' && !modifier)) { e.preventDefault(); applySuggestion(suggestions[suggestionIdx]); return; } 
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSuggestionIdx(p => (p > 0 ? p - 1 : suggestions.length - 1)); return; } 
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSuggestionIdx(p => (p < suggestions.length - 1 ? p + 1 : 0)); return; } 
      else if (e.key === 'Escape') { setSuggestions([]); return; }
    } else {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const el = textareaRef.current;
        if (el) {
          const val = el.value;
          const pos = el.selectionStart;
          const isFirstLine = val.lastIndexOf('\n', pos - 1) === -1;
          const isLastLine = val.indexOf('\n', pos) === -1;
          const hist = commandHistoryRef.current;

          if (e.key === 'ArrowUp' && isFirstLine) {
            if (hist.length > 0 && historyIndexRef.current > 0) {
              e.preventDefault();
              if (historyIndexRef.current === hist.length) currentDraftRef.current = val; 
              historyIndexRef.current--;
              const newVal = hist[historyIndexRef.current];
              editor.executeChange(newVal, newVal.length); 
            }
          } else if (e.key === 'ArrowDown' && isLastLine) {
            if (historyIndexRef.current < hist.length) {
              e.preventDefault();
              historyIndexRef.current++;
              const newVal = historyIndexRef.current === hist.length ? currentDraftRef.current : hist[historyIndexRef.current];
              editor.executeChange(newVal, newVal.length);
            }
          }
        }
      }
    }
    
    if (e.key === 'Enter' && !e.shiftKey && !modifier) { e.preventDefault(); handleMainSendAction(); }
    if (e.key === 'Enter' && modifier) { 
      e.preventDefault(); 
      if (textareaRef.current) {
        const val = textareaRef.current.value; const start = textareaRef.current.selectionStart;
        editor.executeChange(val.substring(0, start) + '\n' + val.substring(textareaRef.current.selectionEnd), start + 1);
      }
    }
  };

  const handleSelectFile = async () => {
    const s = await open({ multiple: false }); 
    if (s) setSelectedFilePath(s as string);
  };

  return (
    <div className="panel-container">
      <div className="panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: "15px" }}>
          <span className="panel-title">发送模式：</span>
          <select className="select-box" value={sendMode} onChange={(e) => setSendMode(e.target.value as SendMode)}>
            <option value="ascii">📝 手动 (ASCII)</option>
            <option value="hex">📦 手动 (HEX)</option>
            <option value="timed">⏱️ 定时发送</option>
            <option value="file">📁 文件发送</option>
          </select>
          <div className="panel-options">
            {sendMode === 'ascii' && <label><input type="checkbox" checked={appendCrlf} onChange={(e) => setAppendCrlf(e.target.checked)} />加回车换行</label>}
            {sendMode === 'timed' && (
              <>
                <label style={{ color: timedIsHex ? "#e91e63" : "#555" }}><input type="checkbox" checked={timedIsHex} onChange={(e) => setTimedIsHex(e.target.checked)} disabled={isTimerRunning} />以 HEX 发送</label>
                {(!timedIsHex) && <label><input type="checkbox" checked={appendCrlf} onChange={(e) => setAppendCrlf(e.target.checked)} disabled={isTimerRunning} />加回车换行</label>}
                <span>间隔: <input type="number" className="interval-input" value={timerInterval} onChange={(e) => setTimerInterval(Number(e.target.value))} disabled={isTimerRunning} /> ms</span>
              </>
            )}
            {(sendMode === 'ascii' || sendMode === 'hex') && <label><input type="checkbox" checked={clearAfterSend} onChange={(e) => setClearAfterSend(e.target.checked)} />发送后清空</label>}
          </div>
        </div>
      </div>

      {suggestions.length > 0 && sendMode !== 'file' && (
        <div className="suggestions-popup">
          <div className="suggestions-list">
            {suggestions.map((s, idx) => (
              <div key={s.id} className={`suggestion-item ${idx === suggestionIdx ? 'active' : ''}`} onMouseDown={(e) => { e.preventDefault(); applySuggestion(s); }} onMouseEnter={() => setSuggestionIdx(idx)}>
                <span className="suggestion-data">{s.data}</span><span className="suggestion-name">({s.name})</span>
              </div>
            ))}
          </div>
          <div className="suggestions-footer">按 Tab/Enter 补全，↑/↓/滚轮 切换</div>
        </div>
      )}

      <div style={{ display: "flex", gap: "10px", alignItems: "stretch" }}>
        {sendMode === 'file' ? (
          <div className="file-selector">
            <div style={{ fontSize: "20px", opacity: 0.5 }}>📄</div>
            <input type="text" value={selectedFilePath} readOnly placeholder="请点击右侧按钮选择文件..." className="file-input" />
            <button onClick={handleSelectFile} className="btn-browse">浏览文件</button>
          </div>
        ) : (
          <SmartInput 
            ref={textareaRef}
            isDisabled={!isConnected || (sendMode === 'timed' && isTimerRunning)}
            placeholderText={sendMode === 'hex' ? "在此输入 HEX 数据(如: FF 0A)..." : "在此输入发送内容(换行: Ctrl+Enter)..."}
            onInput={editor.triggerInput}
            onKeyDown={handleKeyDown}
            onFocus={() => { try { setQuickCommands(JSON.parse(localStorage.getItem('serial-quick-commands') || '[]')); } catch (e) {} }}
            onBlur={() => setTimeout(() => setSuggestions([]), 150)}
          />
        )}
        <button 
          onClick={handleMainSendAction} 
          disabled={!isConnected} 
          className={`btn-send ${!isConnected ? 'disconnected' : isTimerRunning ? 'running' : ''}`}
        >
          <span>{sendMode === 'timed' ? (isTimerRunning ? '停止定时' : '开始定时') : sendMode === 'file' ? '发送文件' : '发送'}</span>
          {sendMode !== 'timed' && sendMode !== 'file' && <span className="btn-send-hint">(Enter)</span>}
        </button>
      </div>
    </div>
  );
});


// ==========================================
// 5. 顶层主视图
// ==========================================
export default function BasicView() {
  const { isConnected, logs, clearLogs, isHexRecv, setIsHexRecv, executeSend } = useSerialStore();
  const [showInvisible, setShowInvisible] = useState(false); 

  const handleSaveLogs = useCallback(async () => {
    if (logs.length === 0) return alert("当前没有可保存的日志！");
    try {
      const textContent = logs.map(log => {
        let prefix = log.type === 'send' ? "发送 -> " : log.type === 'recv' ? "接收 <- " : "系统 -- ";
        return `[${log.time}] ${prefix}${log.text.replace(/\r/g, '')}`;
      }).join('\n');
      const filePath = await save({ filters: [{ name: 'Log', extensions: ['txt', 'log'] }], defaultPath: 'serial_log.txt' });
      if (filePath) { await writeTextFile(filePath, textContent); alert("日志保存成功！📂"); }
    } catch (err: any) { alert("保存失败：" + err); }
  }, [logs]);

  return (
    <div className="basic-view-container">
      {/* 🚀 提取的全局 CSS 样式，大幅优化组件内联样式 */}
      <style>{`
        .basic-view-container { flex: 1; height: 100%; display: flex; flex-direction: column; padding: 20px; gap: 15px; position: relative; box-sizing: border-box; }
        .no-copy-text::before { content: attr(data-content); }
        
        /* 日志行 CSS 化优化 */
        .log-row { display: flex; justify-content: space-between; font-family: ${COMMON_FONT}; word-break: break-all; white-space: pre-wrap; font-size: 14px; line-height: 1.5; padding-top: 10px; padding-bottom: 2px; transition: background-color 0.15s ease; }
        .log-row:hover { background-color: rgba(255, 255, 255, 0.05); }
        .log-header { opacity: 0.8; margin-bottom: 4px; padding: 0 15px; user-select: none; font-size: 12px; }
        .log-time { padding-right: 15px; opacity: 0; transition: opacity 0.2s ease; color: #888; font-size: 12px; user-select: none; pointer-events: none; white-space: nowrap; }
        .log-row:hover .log-time { opacity: 1; }

        /* SmartInput 样式 */
        .smart-input-container { flex: 1; position: relative; display: flex; min-width: 0; }
        .smart-input-placeholder { position: absolute; top: 11px; left: 13px; right: 13px; color: #a9a9a9; pointer-events: none; font-family: ${COMMON_FONT}; font-size: 14px; -webkit-font-smoothing: antialiased; line-height: 1.5; user-select: none; white-space: nowrap; overflow: hidden; z-index: 10; }
        .smart-input-textarea { width: 100%; height: 60px; padding: 10px 12px; border-radius: 6px; border: 1px solid #d9d9d9; outline: none; resize: none; font-family: ${COMMON_FONT}; font-size: 14px; -webkit-font-smoothing: antialiased; line-height: 1.5; cursor: text; background-color: #fff; box-sizing: border-box; overflow-y: auto; word-break: break-all; white-space: pre-wrap; }
        .smart-input-textarea.disabled { cursor: not-allowed; background-color: #f5f5f5; }

        /* Panel 样式 */
        .panel-container { display: flex; flex-direction: column; gap: 8px; background-color: #fff; padding: 10px 15px; border-radius: 8px; box-shadow: 0 -2px 10px rgba(0,0,0,0.02); position: relative; }
        .panel-header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 6px; border-bottom: 1px solid #eee; }
        .panel-title { font-weight: bold; font-size: 14px; color: #333; }
        .select-box { padding: 4px 8px; border-radius: 4px; border: 1px solid #ccc; outline: none; cursor: pointer; font-size: 13px; }
        .panel-options { display: flex; gap: 15px; margin-left: 10px; border-left: 1px solid #ddd; padding-left: 15px; }
        .panel-options label { font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 4px; color: #555; }
        .interval-input { width: 60px; padding: 2px; border: 1px solid #ccc; border-radius: 3px; }
        
        .file-selector { flex: 1; display: flex; align-items: center; gap: 10px; background-color: #fafafa; padding: 8px 15px; border-radius: 6px; border: 1px dashed #d9d9d9; min-height: 60px; box-sizing: border-box; }
        .file-input { flex: 1; padding: 8px 12px; border-radius: 4px; border: 1px solid #ccc; outline: none; background-color: #fff; font-size: 14px; }
        .btn-browse { padding: 8px 15px; cursor: pointer; border: 1px solid #1890ff; background-color: #e6f7ff; color: #1890ff; border-radius: 4px; font-weight: bold; font-size: 14px; }
        
        .btn-send { width: 120px; cursor: pointer; background-color: #1890ff; color: white; border: none; border-radius: 6px; font-weight: bold; font-size: 15px; display: flex; flex-direction: row; align-items: center; justify-content: center; gap: 6px; transition: all 0.2s; }
        .btn-send.disconnected { cursor: not-allowed; background-color: #d9d9d9; }
        .btn-send.running { background-color: #ff4d4f; }
        .btn-send-hint { font-size: 12px; font-weight: normal; opacity: 0.8; }

        .suggestions-popup { position: absolute; bottom: 100%; left: 15px; margin-bottom: 8px; background-color: #fff; border: 1px solid #ccc; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); z-index: 100; min-width: 300px; display: flex; flex-direction: column; overflow: hidden; }
        .suggestions-list { max-height: 175px; overflow-y: auto; }
        .suggestion-item { padding: 8px 12px; background-color: #fff; cursor: pointer; border-bottom: 1px solid #f0f0f0; font-size: 13px; color: #333; }
        .suggestion-item.active { background-color: #e6f7ff; }
        .suggestion-data { font-weight: bold; color: #0050b3; }
        .suggestion-name { color: #888; margin-left: 10px; }
        .suggestions-footer { padding: 4px 12px; font-size: 11px; color: #bbb; background-color: #fafafa; text-align: right; border-top: 1px solid #eee; }
      `}</style>
      
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", backgroundColor: "#fff", padding: "8px 15px", borderRadius: "8px", border: "1px solid #e8e8e8", boxShadow: "0 1px 4px rgba(0,0,0,0.02)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "50%", backgroundColor: isConnected ? "#52c41a" : "#f5222d", boxShadow: isConnected ? "0 0 6px #52c41a" : "none" }}></span>
          <span style={{ fontSize: "15px", fontWeight: "bold", color: "#333" }}>{isConnected ? "已连接" : "未连接"}</span>
        </div>
        
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontSize: "13px", color: "#666" }}>解析:</span>
              <select value={isHexRecv ? "hex" : "ascii"} onChange={(e) => setIsHexRecv(e.target.value === "hex")} className="select-box" style={{ backgroundColor: "#fafafa" }}>
                <option value="ascii">📝 ASCII</option><option value="hex">📦 HEX</option>
              </select>
            </div>
            <label style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "4px", color: isHexRecv ? "#bbb" : "#555", fontSize: "13px" }}>
              <input type="checkbox" checked={showInvisible} onChange={(e) => setShowInvisible(e.target.checked)} disabled={isHexRecv} /> 显示不可见字符
            </label>
          </div>
          <div style={{ width: "1px", height: "18px", backgroundColor: "#e0e0e0" }}></div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <button onClick={handleSaveLogs} style={{ cursor: "pointer", padding: "4px 12px", borderRadius: "4px", border: "1px solid #b7eb8f", backgroundColor: "#f6ffed", color: "#389e0d", fontSize: "13px", display: "flex", alignItems: "center", gap: "4px" }}><span>💾</span> 保存</button>
            <button onClick={clearLogs} style={{ cursor: "pointer", padding: "4px 12px", borderRadius: "4px", border: "1px solid #d9d9d9", backgroundColor: "#fff", color: "#555", fontSize: "13px", display: "flex", alignItems: "center", gap: "4px" }}><span>🗑️</span> 清空</button>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, backgroundColor: "#1e1e1e", borderRadius: "8px", overflow: "hidden", boxShadow: "inset 0 2px 10px rgba(0,0,0,0.2)" }}>
        {logs.length === 0 ? <div style={{ padding: "15px", color: "#666", fontFamily: "monospace", fontSize: "14px" }}>等待数据传输...</div> : (
          <Virtuoso style={{ height: '100%', width: '100%' }} data={logs} followOutput="auto" overscan={8000} itemContent={(idx, log) => <LogRow log={log} showInvisible={showInvisible} />} />
        )}
      </div>

      <SendControlPanel isConnected={isConnected} executeSend={executeSend} />
    </div>
  );
}
