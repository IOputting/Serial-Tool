import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';

type LogType = 'send' | 'recv' | 'sys';
interface LogEntry {
  id: string;
  type: LogType;
  text: string;
  time: string;
  isHex: boolean;
}

interface PortInfo {
  name: string;
  desc: string;
}

interface QuickCommand {
  id: string;
  name: string;
  data: string;
  isHex: boolean;
}

const getTimestamp = () => {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
};

function App() {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [baudRate, setBaudRate] = useState("115200");
  const [isConnected, setIsConnected] = useState(false);
  
  const [logs, setLogs] = useState<LogEntry[]>([]);
  
  const [sendText, setSendText] = useState("");
  const [appendCrlf, setAppendCrlf] = useState(true);
  const [isHexSend, setIsHexSend] = useState(false);
  const [clearAfterSend, setClearAfterSend] = useState(true); 
  const [showInvisible, setShowInvisible] = useState(false); 
  
  const [isHexRecv, setIsHexRecv] = useState(false);
  const isHexRecvRef = useRef(false);
  const decoderRef = useRef(new TextDecoder("utf-8"));
  const logEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const draftRef = useRef(""); 

  const [showSearch, setShowSearch] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [activeSearchIdx, setActiveSearchIdx] = useState(-1);
  const [totalSearchMatches, setTotalSearchMatches] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const undoStack = useRef<string[]>([]);
  const redoStack = useRef<string[]>([]);
  const lastSaveTime = useRef<number>(0);

  // 快捷指令与侧边栏状态
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([]);
  const [newCmdName, setNewCmdName] = useState("");
  const [newCmdData, setNewCmdData] = useState("");
  const [newCmdIsHex, setNewCmdIsHex] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // 侧边栏折叠状态与指令搜索状态
  const [showSidebar, setShowSidebar] = useState(true);
  const [quickCmdSearch, setQuickCmdSearch] = useState("");

  // 智能补全状态
  const [suggestions, setSuggestions] = useState<QuickCommand[]>([]);
  const [suggestionIdx, setSuggestionIdx] = useState(0);

  useEffect(() => {
    const saved = localStorage.getItem('serial-quick-commands');
    if (saved) {
      try { setQuickCommands(JSON.parse(saved)); } catch (e) {}
    } else {
      setQuickCommands([
        { id: crypto.randomUUID(), name: "测试 AT", data: "AT", isHex: false },
        { id: crypto.randomUUID(), name: "查询版本", data: "AT+GMR", isHex: false },
        { id: crypto.randomUUID(), name: "重启设备", data: "AT+RST", isHex: false }
      ]);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('serial-quick-commands', JSON.stringify(quickCommands));
  }, [quickCommands]);

  useEffect(() => {
    isHexRecvRef.current = isHexRecv;
    if (!isHexRecv) decoderRef.current = new TextDecoder("utf-8");
  }, [isHexRecv]);

  useEffect(() => {
    if (isConnected && textareaRef.current) setTimeout(() => textareaRef.current?.focus(), 50);
  }, [isConnected]);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      } else if (e.key === 'Escape' && showSearch) {
        setShowSearch(false);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [showSearch]);

  useEffect(() => {
    if (!showSearch || !searchText) { setTotalSearchMatches(0); setActiveSearchIdx(-1); return; }
    const timer = setTimeout(() => {
      const marks = document.querySelectorAll<HTMLElement>('#log-container mark.search-match');
      setTotalSearchMatches(marks.length);
      if (marks.length > 0) {
        let nextIdx = activeSearchIdx >= 0 && activeSearchIdx < marks.length ? activeSearchIdx : 0;
        setActiveSearchIdx(nextIdx);
        updateActiveHighlight(nextIdx, marks);
      } else { setActiveSearchIdx(-1); }
    }, 50);
    return () => clearTimeout(timer);
  }, [logs, searchText, useRegex, showSearch]);

  useEffect(() => {
    if (totalSearchMatches > 0 && activeSearchIdx >= 0) updateActiveHighlight(activeSearchIdx);
  }, [activeSearchIdx]);

  const updateActiveHighlight = (idx: number, marksList?: NodeListOf<HTMLElement>) => {
    const marks = marksList || document.querySelectorAll<HTMLElement>('#log-container mark.search-match');
    marks.forEach((m, i) => {
      if (i === idx) { m.style.backgroundColor = '#ff9800'; m.style.color = '#fff'; m.scrollIntoView({ behavior: 'smooth', block: 'center' }); } 
      else { m.style.backgroundColor = '#ffeb3b'; m.style.color = '#000'; }
    });
  };

  const fetchPorts = async () => {
    const res = await invoke<PortInfo[]>("get_available_ports");
    setPorts(res);
    if (res.length > 0 && !selectedPort) setSelectedPort(res[0].name);
  };

  useEffect(() => {
    fetchPorts();
    const unlistenData = listen<number[]>("serial-data", (event) => {
      const bytes = new Uint8Array(event.payload);
      let newText = "";
      const isHex = isHexRecvRef.current;
      if (isHex) newText = Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ') + ' ';
      else newText = decoderRef.current.decode(bytes, { stream: true });
      if (!newText) return;

      setLogs(prev => {
        const lastLog = prev[prev.length - 1];
        if (lastLog && lastLog.type === 'recv' && lastLog.isHex === isHex) {
          const updated = [...prev]; updated[updated.length - 1] = { ...lastLog, text: lastLog.text + newText }; return updated;
        } else { return [...prev, { id: crypto.randomUUID(), type: 'recv', text: newText, time: getTimestamp(), isHex }]; }
      });
    });

    const unlistenDisconnect = listen<string>("serial-disconnected", async (event) => {
      setIsConnected(false); addSysLog(`设备连接断开 (${event.payload}) 🔴`);
      try { await invoke("disconnect_port"); } catch (e) {}
    });

    return () => { unlistenData.then((f) => f()); unlistenDisconnect.then((f) => f()); };
  }, []);

  useEffect(() => {
    const handleUnload = () => { if (isConnected) invoke("disconnect_port").catch(() => {}); };
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [isConnected]);

  useEffect(() => { if (!showSearch) logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs, showSearch]);

  const addSysLog = (msg: string) => setLogs(prev => [...prev, { id: crypto.randomUUID(), type: 'sys', text: msg + '\n', time: getTimestamp(), isHex: false }]);

  const toggleConnection = async () => {
    if (isConnected) {
      await invoke("disconnect_port"); setIsConnected(false); addSysLog("串口已手动断开 🔴");
    } else {
      if (!selectedPort) return alert("请先插入并选择设备！");
      try {
        await invoke("connect_port", { portName: selectedPort, baudRate: Number(baudRate) });
        setIsConnected(true); addSysLog(`已连接 ${selectedPort} (${baudRate}) 🟢`);
      } catch (e) { alert("连接失败，可能是串口被占用: " + e); }
    }
  };

  const saveUndoState = (val: string) => {
    if (undoStack.current[undoStack.current.length - 1] !== val) {
      undoStack.current.push(val); if (undoStack.current.length > 50) undoStack.current.shift();
    }
    redoStack.current = [];
  };

  const executeSend = async (data: string, isHex: boolean, useCrlf: boolean) => {
    if (!isConnected) return alert("请先连接串口！");
    if (!data) return;
    let dataToSend = data;
    if (!isHex && useCrlf) dataToSend += "\r\n"; 
    try {
      await invoke("send_data", { data: dataToSend, isHex: isHex });
      setLogs(prev => [...prev, { id: crypto.randomUUID(), type: 'send', text: dataToSend + (isHex ? '\n' : ''), time: getTimestamp(), isHex: isHex }]);
      return true;
    } catch (e) { alert("发送报错: " + e); return false; }
  };

  const handleSend = async () => {
    const success = await executeSend(sendText, isHexSend, appendCrlf);
    if (success) {
      const trimmedData = sendText.trim();
      if (trimmedData) setCmdHistory(prev => { if (prev[prev.length - 1] === sendText) return prev; return [...prev, sendText]; });
      setHistoryIdx(-1); draftRef.current = "";
      if (clearAfterSend) { saveUndoState(sendText); setSendText(""); setSuggestions([]); }
    }
  };

  const addQuickCommand = () => {
    if (!newCmdName || !newCmdData) return alert("名称和内容不能为空！");
    setQuickCommands([...quickCommands, { id: crypto.randomUUID(), name: newCmdName, data: newCmdData, isHex: newCmdIsHex }]);
    setNewCmdName(""); setNewCmdData("");
  };

  // 💡 修改：使用系统原生“另存为”对话框导出配置
  // 💡 使用 Tauri 原生 API 进行导出
  const exportCommands = async () => {
    try {
      const dataStr = JSON.stringify(quickCommands, null, 2);
      const filePath = await save({
        filters: [{ name: 'JSON 配置文件', extensions: ['json'] }],
        defaultPath: 'serial_commands_backup.json',
      });

      if (filePath) {
        await writeTextFile(filePath, dataStr);
        alert("导出成功！");
      }
    } catch (err: any) {
      // 💡 修复：兼容 Tauri 返回的字符串错误
      const errorMsg = typeof err === 'string' ? err : (err?.message || JSON.stringify(err));
      alert("导出失败：" + errorMsg);
      console.error("详细错误:", err); // 顺便在控制台打印一下
    }
  };

  const importCommands = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try { const imported = JSON.parse(event.target?.result as string);
        if (Array.isArray(imported)) { setQuickCommands(imported); alert("导入成功！"); } else { alert("文件格式不正确！"); }
      } catch (err) { alert("解析 JSON 失败！"); }
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    reader.readAsText(file);
  };

  // 提取正在输入的单词，触发智能补全
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setSendText(val);

    const cursor = e.target.selectionStart;
    const textBeforeCursor = val.substring(0, cursor);
    const words = textBeforeCursor.split(/\s+/); 
    const currentWord = words[words.length - 1]; 

    if (currentWord.length > 0) {
      const matches = quickCommands.filter(c => c.data.toLowerCase().startsWith(currentWord.toLowerCase()));
      setSuggestions(matches);
      setSuggestionIdx(0);
    } else {
      setSuggestions([]);
    }
  };

  // 应用补全词
  const applySuggestion = (selected: QuickCommand) => {
    if (!textareaRef.current) return;
    const target = textareaRef.current;
    const cursor = target.selectionStart;
    const textBeforeCursor = sendText.substring(0, cursor);
    const words = textBeforeCursor.split(/\s+/);
    const currentWord = words[words.length - 1];
    
    const newTextBefore = textBeforeCursor.substring(0, textBeforeCursor.length - currentWord.length) + selected.data;
    const newText = newTextBefore + sendText.substring(cursor);

    setSendText(newText);
    setSuggestions([]);

    setTimeout(() => {
      target.focus();
      target.selectionStart = target.selectionEnd = newTextBefore.length;
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const target = e.target as HTMLTextAreaElement;

    // 如果智能补全框开启，拦截特殊按键
    if (suggestions.length > 0) {
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey)) {
        e.preventDefault();
        applySuggestion(suggestions[suggestionIdx]);
        return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSuggestionIdx(prev => (prev > 0 ? prev - 1 : suggestions.length - 1));
        return;
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSuggestionIdx(prev => (prev < suggestions.length - 1 ? prev + 1 : 0));
        return;
      } else if (e.key === 'Escape') {
        setSuggestions([]);
        return;
      }
    }

    if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); if (undoStack.current.length > 0) { redoStack.current.push(sendText); setSendText(undoStack.current.pop()!); } return; }
    if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); if (redoStack.current.length > 0) { undoStack.current.push(sendText); setSendText(redoStack.current.pop()!); } return; }
    if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) { const now = Date.now(); if (now - lastSaveTime.current > 400 || e.key === ' ') { saveUndoState(sendText); lastSaveTime.current = now; } }

    if (e.key === 'Enter') {
      if (e.ctrlKey) {
        e.preventDefault(); saveUndoState(sendText);
        const start = target.selectionStart; const end = target.selectionEnd;
        const newValue = sendText.substring(0, start) + '\n' + sendText.substring(end);
        setSendText(newValue);
        setTimeout(() => { target.selectionStart = target.selectionEnd = start + 1; }, 0);
      } else if (!e.shiftKey) {
        e.preventDefault(); handleSend();
      }
    } 
    else if (e.key === 'ArrowUp') {
      if (target.selectionStart === 0 && target.selectionEnd === 0) {
        if (cmdHistory.length > 0) {
          e.preventDefault(); saveUndoState(sendText);
          if (historyIdx === -1) { draftRef.current = sendText; const newIdx = cmdHistory.length - 1; setHistoryIdx(newIdx); setSendText(cmdHistory[newIdx]); } 
          else if (historyIdx > 0) { const newIdx = historyIdx - 1; setHistoryIdx(newIdx); setSendText(cmdHistory[newIdx]); }
        }
      }
    } 
    else if (e.key === 'ArrowDown') {
      if (target.selectionStart === sendText.length && target.selectionEnd === sendText.length) {
        if (historyIdx !== -1) {
          e.preventDefault(); saveUndoState(sendText);
          if (historyIdx < cmdHistory.length - 1) { const newIdx = historyIdx + 1; setHistoryIdx(newIdx); setSendText(cmdHistory[newIdx]); } 
          else { setHistoryIdx(-1); setSendText(draftRef.current); }
        }
      }
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (totalSearchMatches === 0) return;
    if (e.key === 'ArrowDown' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); setActiveSearchIdx(prev => (prev + 1) % totalSearchMatches); } 
    else if (e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)) { e.preventDefault(); setActiveSearchIdx(prev => (prev - 1 + totalSearchMatches) % totalSearchMatches); }
  };

  const renderHighlightedText = (text: string, isHex: boolean) => {
    let baseText = text;
    if (!isHex && showInvisible) baseText = baseText.replace(/\r/g, '\\r').replace(/\n/g, '\\n\n').replace(/\0/g, '\\0');
    if (!showSearch || !searchText) return baseText;

    try {
      const re = useRegex ? new RegExp(searchText, 'gi') : new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const matches = Array.from(baseText.matchAll(re));
      if (matches.length === 0) return baseText;

      const result = []; let lastIdx = 0;
      for (let i = 0; i < matches.length; i++) {
        const match = matches[i]; const start = match.index!; const matchText = match[0];
        if (matchText.length === 0) continue;
        result.push(baseText.substring(lastIdx, start));
        result.push(<mark key={`${i}-mark`} className="search-match" style={{ backgroundColor: "#ffeb3b", color: "#000", borderRadius: "2px", padding: "0 2px" }}>{matchText}</mark>);
        lastIdx = start + matchText.length;
      }
      result.push(baseText.substring(lastIdx));
      return result;
    } catch (e) { return baseText; }
  };

  return (
    <div style={{ padding: "20px", fontFamily: "sans-serif", display: "flex", gap: "20px", height: "100vh", boxSizing: "border-box", backgroundColor: "#f9f9f9", overflow: "hidden" }}>
      
      {/* 左侧主控制区 */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", position: "relative", minWidth: "500px", transition: "all 0.3s ease" }}>
        
        {showSearch && (
          <div style={{ position: "absolute", top: "10px", right: "20px", zIndex: 100, backgroundColor: "#fff", padding: "10px 15px", borderRadius: "8px", boxShadow: "0 4px 12px rgba(0,0,0,0.15)", display: "flex", gap: "10px", alignItems: "center", border: "1px solid #ddd" }}>
            <span style={{ fontSize: "14px", color: "#555" }}>🔍 查找:</span>
            <input ref={searchInputRef} type="text" value={searchText} onChange={(e) => setSearchText(e.target.value)} onKeyDown={handleSearchKeyDown} placeholder="关键字/正则 (↑/↓切换)" style={{ padding: "6px", borderRadius: "4px", border: "1px solid #ccc", outline: "none", width: "160px" }}/>
            <span style={{ fontSize: "12px", color: "#888", minWidth: "40px", textAlign: "center" }}>{totalSearchMatches > 0 ? `${activeSearchIdx + 1} / ${totalSearchMatches}` : "0 / 0"}</span>
            <label style={{ fontSize: "13px", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px", paddingLeft: "5px", borderLeft: "1px solid #eee" }}><input type="checkbox" checked={useRegex} onChange={(e) => setUseRegex(e.target.checked)} /> Regex</label>
            <button onClick={() => setShowSearch(false)} style={{ border: "none", background: "none", cursor: "pointer", fontSize: "16px", color: "#888", marginLeft: "5px" }} title="关闭 (Esc)">✖</button>
          </div>
        )}

        <h2 style={{ margin: "0 0 15px 0", color: "#333" }}>                        Hello hello Hi Hi Hi</h2>
        
        <div style={{ display: "flex", gap: "10px", marginBottom: "15px", alignItems: "center", flexWrap: "wrap" }}>
          <select value={selectedPort} onChange={(e) => setSelectedPort(e.target.value)} onFocus={fetchPorts} onMouseEnter={fetchPorts} disabled={isConnected} style={{ width: "220px", padding: "6px", borderRadius: "4px", border: "1px solid #ccc", textOverflow: "ellipsis" }}>
            {ports.length === 0 && <option value="">未找到设备</option>}
            {ports.map((p) => <option key={p.name} value={p.name} title={p.desc}>{p.desc}</option>)}
          </select>
          <input list="baud-rates" value={baudRate} onChange={(e) => setBaudRate(e.target.value)} disabled={isConnected} placeholder="波特率" style={{ width: "90px", padding: "6px", borderRadius: "4px", border: "1px solid #ccc" }}/>
          <datalist id="baud-rates"><option value="9600"/><option value="115200"/><option value="921600"/></datalist>
          <button onClick={toggleConnection} style={{ cursor: "pointer", backgroundColor: isConnected ? "#ff4d4f" : "#4CAF50", color: "white", border: "none", padding: "8px 15px", borderRadius: "4px", fontWeight: "bold" }}>{isConnected ? "断开" : "连接"}</button>
          <label style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "5px", marginLeft: "10px", color: isHexRecv ? "#e91e63" : "#555", fontWeight: "bold" }}><input type="checkbox" checked={isHexRecv} onChange={(e) => setIsHexRecv(e.target.checked)} /> HEX 接收</label>
          <label style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "5px", color: "#555", fontSize: "14px" }}><input type="checkbox" checked={showInvisible} onChange={(e) => setShowInvisible(e.target.checked)} /> 显示不可见字符</label>
          
          {/* 工具栏右侧按钮组 */}
          <div style={{ marginLeft: "auto", display: "flex", gap: "8px" }}>
            <button onClick={() => { setShowSearch(true); setTimeout(() => searchInputRef.current?.focus(), 50); }} style={{ cursor: "pointer", padding: "8px 15px", borderRadius: "4px", border: "1px solid #ccc", backgroundColor: "#fff" }}>🔍 搜索</button>
            <button onClick={() => setLogs([])} style={{ cursor: "pointer", padding: "8px 15px", borderRadius: "4px", border: "1px solid #ccc", backgroundColor: "#fff" }}>🗑️ 清屏</button>
            
            <button onClick={() => setShowSidebar(!showSidebar)} style={{ cursor: "pointer", padding: "8px 15px", borderRadius: "4px", border: "1px solid #ccc", backgroundColor: showSidebar ? "#e6f7ff" : "#fff", color: showSidebar ? "#0050b3" : "#333", fontWeight: showSidebar ? "bold" : "normal" }}>
              {showSidebar ? "▶ 收起侧栏" : "◀ 快捷指令"}
            </button>
          </div>
        </div>

        <div id="log-container" style={{ flex: 1, backgroundColor: "#1e1e1e", padding: "15px", borderRadius: "8px", overflowY: "auto", whiteSpace: "pre-wrap", fontFamily: "'Cascadia Code', Consolas, monospace", fontSize: "14px", marginBottom: "15px", boxShadow: "inset 0 0 10px rgba(0,0,0,0.5)" }}>
          {logs.length === 0 ? <span style={{ color: "#666" }}>等待接收数据...</span> : null}
          {logs.map((log) => {
            let color = "#fff"; let prefix = "";
            if (log.type === 'send') { color = "#00e5ff"; prefix = "-> "; } 
            else if (log.type === 'recv') { color = "#00e676"; prefix = "<- "; } 
            else if (log.type === 'sys') { color = "#ffb300"; prefix = "SYS "; } 
            return (
              <div key={log.id} style={{ color: color, wordBreak: "break-all", marginBottom: "4px", lineHeight: "1.4" }}>
                <span style={{ color: "#888", marginRight: "8px", userSelect: "none" }}>[{log.time}]</span>
                <span style={{ opacity: 0.6, userSelect: "none", marginRight: "5px" }}>{prefix}</span>
                <span>{renderHighlightedText(log.text, log.isHex)}</span>
              </div>
            );
          })}
          <div ref={logEndRef} />
        </div>

        <div style={{ display: "flex", gap: "10px", alignItems: "flex-end", backgroundColor: "#fff", padding: "12px", borderRadius: "8px", border: "1px solid #ddd", boxShadow: "0 2px 5px rgba(0,0,0,0.05)", position: "relative" }}>
          
          {/* 智能补全弹出层 */}
          {suggestions.length > 0 && (
            <div style={{ position: 'absolute', bottom: '100%', left: '0', marginBottom: '8px', backgroundColor: '#fff', border: '1px solid #ccc', borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)', zIndex: 1000, maxHeight: '200px', overflowY: 'auto', minWidth: '300px', display: 'flex', flexDirection: 'column' }}>
              {suggestions.map((s, idx) => (
                <div 
                  key={s.id} 
                  style={{ padding: '8px 12px', backgroundColor: idx === suggestionIdx ? '#e6f7ff' : '#fff', cursor: 'pointer', borderBottom: '1px solid #f0f0f0', fontSize: '13px', color: '#333' }}
                  onMouseDown={(e) => { e.preventDefault(); applySuggestion(s); }}
                >
                  <span style={{ fontWeight: 'bold', color: '#0050b3' }}>{s.data}</span>
                  <span style={{ color: '#888', marginLeft: '10px' }}>({s.name})</span>
                </div>
              ))}
              <div style={{ padding: '4px 12px', fontSize: '11px', color: '#bbb', backgroundColor: '#fafafa', textAlign: 'right' }}>按 Tab 或 Enter 补全，↑/↓ 切换</div>
            </div>
          )}

          <textarea 
            ref={textareaRef} value={sendText} onChange={handleTextareaChange} onKeyDown={handleKeyDown} 
            onBlur={() => setTimeout(() => setSuggestions([]), 150)}
            disabled={!isConnected}
            placeholder="在此输入指令 (支持智能补全 Tab, Ctrl+Enter 换行, ↑/↓ 查找历史)..." 
            style={{ 
              flex: 1, minHeight: "40px", height: "40px", padding: "8px 12px", borderRadius: "4px", border: "1px solid #ccc", outline: "none", resize: "none", overflowY: "auto", fontFamily: "inherit", fontSize: "14px", lineHeight: "1.5", boxSizing: "border-box", wordBreak: "break-all", whiteSpace: "pre-wrap", cursor: isConnected ? "text" : "not-allowed", backgroundColor: isConnected ? "#fff" : "#f5f5f5" 
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "2px" }}>
            <div style={{ display: "flex", gap: "10px" }}>
              <label style={{ fontSize: "13px", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px", color: "#555" }}><input type="checkbox" checked={clearAfterSend} onChange={(e) => setClearAfterSend(e.target.checked)} />发送后清空</label>
              <label style={{ fontSize: "13px", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px", color: "#555" }}><input type="checkbox" checked={appendCrlf} onChange={(e) => setAppendCrlf(e.target.checked)} disabled={isHexSend} />加回车换行</label>
              <label style={{ fontSize: "13px", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px", color: isHexSend ? "#e91e63" : "#555", fontWeight: isHexSend ? "bold" : "normal" }}><input type="checkbox" checked={isHexSend} onChange={(e) => setIsHexSend(e.target.checked)} />HEX 发送</label>
            </div>
            <button onClick={handleSend} disabled={!isConnected} style={{ cursor: isConnected ? "pointer" : "not-allowed", backgroundColor: isConnected ? "#007bff" : "#ccc", color: "white", border: "none", padding: "8px 25px", borderRadius: "4px", fontWeight: "bold", transition: "background-color 0.2s", width: "100%" }}>发送 🚀</button>
          </div>
        </div>
      </div>

      {/* 右侧：快捷指令侧边栏 */}
      <div style={{ 
        width: showSidebar ? "320px" : "0px", 
        opacity: showSidebar ? 1 : 0,
        transition: "width 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease", 
        display: "flex", flexDirection: "column", 
        backgroundColor: "#fff", borderRadius: "8px", border: showSidebar ? "1px solid #ddd" : "none", 
        boxShadow: showSidebar ? "0 2px 10px rgba(0,0,0,0.05)" : "none", overflow: "hidden", flexShrink: 0
      }}>
        <div style={{ width: "318px", display: "flex", flexDirection: "column", height: "100%" }}>
          <div style={{ padding: "12px 15px", backgroundColor: "#f1f1f1", borderBottom: "1px solid #ddd", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0, fontSize: "16px", color: "#333" }}>📝 快捷指令</h3>
            <div style={{ display: "flex", gap: "5px" }}>
              <button onClick={exportCommands} title="导出配置" style={{ cursor: "pointer", background: "none", border: "1px solid #ccc", borderRadius: "4px", padding: "4px 8px", fontSize: "12px", backgroundColor: "#fff" }}>导出</button>
              <button onClick={() => fileInputRef.current?.click()} title="导入配置" style={{ cursor: "pointer", background: "none", border: "1px solid #ccc", borderRadius: "4px", padding: "4px 8px", fontSize: "12px", backgroundColor: "#fff" }}>导入</button>
              <input type="file" accept=".json" style={{ display: "none" }} ref={fileInputRef} onChange={importCommands} />
            </div>
          </div>

          <div style={{ padding: "8px 12px", borderBottom: "1px solid #eee" }}>
            <input 
              type="text" 
              value={quickCmdSearch} 
              onChange={(e) => setQuickCmdSearch(e.target.value)} 
              placeholder="🔍 搜索指令名称或内容..." 
              style={{ width: "100%", padding: "6px 8px", borderRadius: "4px", border: "1px solid #ddd", boxSizing: "border-box", outline: "none", fontSize: "13px" }}
            />
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "10px" }}>
            {quickCommands.filter(c => c.name.toLowerCase().includes(quickCmdSearch.toLowerCase()) || c.data.toLowerCase().includes(quickCmdSearch.toLowerCase())).length === 0 && (
              <div style={{ textAlign: "center", color: "#999", marginTop: "20px", fontSize: "13px" }}>无匹配的指令</div>
            )}
            
            {quickCommands
              .filter(c => c.name.toLowerCase().includes(quickCmdSearch.toLowerCase()) || c.data.toLowerCase().includes(quickCmdSearch.toLowerCase()))
              .map((cmd) => (
              <div key={cmd.id} style={{ display: "flex", flexDirection: "column", backgroundColor: "#fafafa", border: "1px solid #eee", borderRadius: "6px", padding: "8px", marginBottom: "8px", position: "relative", transition: "all 0.2s hover" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                  <span style={{ fontWeight: "bold", color: "#444", fontSize: "13px", display: "flex", alignItems: "center", gap: "5px" }}>
                    {cmd.name}
                    {cmd.isHex && <span style={{ backgroundColor: "#e91e63", color: "white", fontSize: "10px", padding: "1px 4px", borderRadius: "3px" }}>HEX</span>}
                  </span>
                  <button onClick={() => setQuickCommands(prev => prev.filter(c => c.id !== cmd.id))} style={{ border: "none", background: "none", color: "#ff4d4f", cursor: "pointer", fontSize: "14px", padding: "0 4px" }} title="删除">✖</button>
                </div>
                <div style={{ fontSize: "12px", color: "#666", wordBreak: "break-all", backgroundColor: "#fff", padding: "4px", border: "1px dashed #ccc", borderRadius: "4px", fontFamily: "monospace", marginBottom: "8px" }}>
                  {cmd.data.length > 50 ? cmd.data.substring(0, 50) + "..." : cmd.data}
                </div>
                <button onClick={() => executeSend(cmd.data, cmd.isHex, appendCrlf)} disabled={!isConnected} style={{ cursor: isConnected ? "pointer" : "not-allowed", backgroundColor: isConnected ? "#e6f7ff" : "#f5f5f5", color: isConnected ? "#0050b3" : "#aaa", border: "1px solid", borderColor: isConnected ? "#91d5ff" : "#d9d9d9", padding: "4px 0", borderRadius: "4px", fontSize: "12px", fontWeight: "bold" }}>发送</button>
              </div>
            ))}
          </div>

          <div style={{ padding: "12px", backgroundColor: "#fafafa", borderTop: "1px solid #ddd", display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ fontSize: "13px", fontWeight: "bold", color: "#555" }}>➕ 添加快捷指令</div>
            <input type="text" value={newCmdName} onChange={(e) => setNewCmdName(e.target.value)} placeholder="名称 (如: 重启)" style={{ padding: "6px", border: "1px solid #ccc", borderRadius: "4px", fontSize: "13px" }} />
            <textarea value={newCmdData} onChange={(e) => setNewCmdData(e.target.value)} placeholder="指令内容..." style={{ padding: "6px", border: "1px solid #ccc", borderRadius: "4px", fontSize: "13px", resize: "vertical", minHeight: "40px", fontFamily: "monospace" }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label style={{ fontSize: "12px", cursor: "pointer", display: "flex", alignItems: "center", gap: "4px", color: newCmdIsHex ? "#e91e63" : "#666" }}>
                <input type="checkbox" checked={newCmdIsHex} onChange={(e) => setNewCmdIsHex(e.target.checked)} />HEX 发送
              </label>
              <button onClick={addQuickCommand} style={{ backgroundColor: "#4CAF50", color: "white", border: "none", borderRadius: "4px", padding: "5px 12px", fontSize: "12px", cursor: "pointer", fontWeight: "bold" }}>保存</button>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}

export default App;
