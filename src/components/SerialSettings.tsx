import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { useSerialStore, getTimestamp, QuickCommand, ViewMode } from "../stores/useSerialStore";

const COMMON_BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
interface PortInfo { name: string; desc: string; }

export default function SerialSettings() {
  const { isConnected, setIsConnected, addLog, executeSend, activeView, setActiveView } = useSerialStore();

  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [baudRate, setBaudRate] = useState("115200");
  const [isCustomBaud, setIsCustomBaud] = useState(false);
  const [dataBits, setDataBits] = useState("8");
  const [parity, setParity] = useState("None");
  const [stopBits, setStopBits] = useState("1");
  const [dtr, setDtr] = useState(false);
  const [rts, setRts] = useState(false);

  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([]);
  const [showCmdModal, setShowCmdModal] = useState(false);
  const [newCmdName, setNewCmdName] = useState("");
  const [newCmdData, setNewCmdData] = useState("");
  const [newCmdIsHex, setNewCmdIsHex] = useState(false);
  const [quickCmdSearch, setQuickCmdSearch] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem('serial-quick-commands');
    if (saved) { try { setQuickCommands(JSON.parse(saved)); } catch (e) {} } 
    else {
      setQuickCommands([
        { id: crypto.randomUUID(), name: "测试 AT", data: "AT", isHex: false },
        { id: crypto.randomUUID(), name: "查询版本", data: "AT+GMR", isHex: false }
      ]);
    }
  }, []);

  useEffect(() => { localStorage.setItem('serial-quick-commands', JSON.stringify(quickCommands)); }, [quickCommands]);

  const fetchPorts = async () => {
    const res = await invoke<PortInfo[]>("get_available_ports");
    setPorts(res);
    if (res.length > 0 && (!selectedPort || !res.find(p => p.name === selectedPort))) {
      setSelectedPort(res[0].name);
    } else if (res.length === 0) {
      setSelectedPort("");
    }
  };

  useEffect(() => { fetchPorts(); }, []);

  // 修复点：在 addLog 中添加了 timestampMs 属性
  const addSysLog = (msg: string) => addLog({ 
    id: crypto.randomUUID(), 
    type: 'sys', 
    text: msg + '\n', 
    time: getTimestamp(), 
    isHex: false,
    timestampMs: Date.now() // 补全此必填字段
  });

  const toggleConnection = async () => {
    if (isConnected) {
      await invoke("disconnect_port"); setIsConnected(false); addSysLog("串口已手动断开 🔴");
    } else {
      if (!selectedPort) return alert("请先选择设备！");
      try {
        await invoke("connect_port", { portName: selectedPort, baudRate: Number(baudRate), dataBits: Number(dataBits), parity, stopBits: Number(stopBits), dtr, rts });
        setIsConnected(true); addSysLog(`已连接 ${selectedPort} (${baudRate}, ${dataBits}, ${parity}, ${stopBits}) 🟢`);
      } catch (e) { alert("连接失败: " + e); }
    }
  };

  const handleDtrChange = async (val: boolean) => { setDtr(val); if (isConnected) await invoke("set_dtr_rts", { dtr: val, rts }); };
  const handleRtsChange = async (val: boolean) => { setRts(val); if (isConnected) await invoke("set_dtr_rts", { dtr, rts: val }); };

  const addQuickCommand = () => {
    if (!newCmdName || !newCmdData) return alert("名称和内容不能为空！");
    setQuickCommands([...quickCommands, { id: crypto.randomUUID(), name: newCmdName, data: newCmdData, isHex: newCmdIsHex }]);
    setNewCmdName(""); setNewCmdData("");
  };

  const exportCommands = async () => {
    try {
      const dataStr = JSON.stringify(quickCommands, null, 2);
      const filePath = await save({ filters: [{ name: 'JSON', extensions: ['json'] }], defaultPath: 'serial_commands.json' });
      if (filePath) { await writeTextFile(filePath, dataStr); alert("导出成功！"); }
    } catch (err: any) { alert("导出失败：" + (typeof err === 'string' ? err : err?.message)); }
  };

  const importCommands = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try { const imported = JSON.parse(event.target?.result as string);
        if (Array.isArray(imported)) { setQuickCommands(imported); alert("导入成功！"); } else alert("格式错误！");
      } catch (err) { alert("解析失败！"); }
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    reader.readAsText(file);
  };

  return (
    <div style={{ width: "220px", minWidth: "220px", display: "flex", flexDirection: "column", backgroundColor: "#fff", borderRight: "1px solid #ddd", zIndex: 10, boxShadow: "2px 0 8px rgba(0,0,0,0.05)" }}>
      {/* 串口配置面板 */}
      <div style={{ padding: "15px", borderBottom: "1px solid #eee" }}>
        
        {/* 视图切换下拉框 */}
        <div style={{ marginBottom: "15px", display: "flex", alignItems: "center", gap: "8px" }}>
          <select 
            value={activeView} 
            onChange={(e) => setActiveView(e.target.value as ViewMode)}
            style={{ width: "100%", padding: "8px", fontSize: "15px", fontWeight: "bold", color: "#333", borderRadius: "6px", border: "1px solid #1890ff", backgroundColor: "#e6f7ff", cursor: "pointer", outline: "none" }}
          >
            <option value="basic">📝 基础通讯</option>
            <option value="oscilloscope">📈 高级示波器</option>
            <option value="script">💻 编程发送</option>
            <option value="GNSSviewer">🛰️ GNSS可视化工具</option>
          </select>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "13px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ color: "#555" }}>端口</span>
            <select value={selectedPort} onChange={(e) => setSelectedPort(e.target.value)} onMouseEnter={fetchPorts} onFocus={fetchPorts} disabled={isConnected} style={{ width: "120px", padding: "4px", borderRadius: "4px", border: "1px solid #ccc", cursor: "pointer" }}>
              {ports.length === 0 && <option value="">无设备</option>}
              {ports.map((p) => <option key={p.name} value={p.name} title={p.desc}>{p.desc}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ color: "#555" }}>波特率</span>
            <div onDoubleClick={() => !isConnected && setIsCustomBaud(true)} title="双击可手动输入" style={{ width: "120px" }}>
              {isCustomBaud ? (
                <input type="number" value={baudRate} onChange={(e) => setBaudRate(e.target.value)} onBlur={() => setIsCustomBaud(false)} autoFocus disabled={isConnected} style={{ width: "100%", padding: "4px", borderRadius: "4px", border: "1px solid #1890ff", boxSizing: "border-box", outline: "none" }} />
              ) : (
                <select value={baudRate} onChange={(e) => setBaudRate(e.target.value)} disabled={isConnected} style={{ width: "100%", padding: "4px", borderRadius: "4px", border: "1px solid #ccc" }}>
                  {!COMMON_BAUD_RATES.includes(Number(baudRate)) && <option value={baudRate}>{baudRate}</option>}
                  {COMMON_BAUD_RATES.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              )}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ color: "#555" }}>数据位</span>
            <select value={dataBits} onChange={(e) => setDataBits(e.target.value)} disabled={isConnected} style={{ width: "120px", padding: "4px", borderRadius: "4px", border: "1px solid #ccc" }}><option value="8">8</option><option value="7">7</option><option value="6">6</option><option value="5">5</option></select>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ color: "#555" }}>校验位</span>
            <select value={parity} onChange={(e) => setParity(e.target.value)} disabled={isConnected} style={{ width: "120px", padding: "4px", borderRadius: "4px", border: "1px solid #ccc" }}><option value="None">None</option><option value="Odd">Odd</option><option value="Even">Even</option></select>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ color: "#555" }}>停止位</span>
            <select value={stopBits} onChange={(e) => setStopBits(e.target.value)} disabled={isConnected} style={{ width: "120px", padding: "4px", borderRadius: "4px", border: "1px solid #ccc" }}><option value="1">1</option><option value="2">2</option></select>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "5px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "5px", cursor: "pointer" }}><input type="checkbox" checked={dtr} onChange={(e) => handleDtrChange(e.target.checked)} /> DTR</label>
            <label style={{ display: "flex", alignItems: "center", gap: "5px", cursor: "pointer" }}><input type="checkbox" checked={rts} onChange={(e) => handleRtsChange(e.target.checked)} /> RTS</label>
          </div>
          <button onClick={toggleConnection} style={{ marginTop: "5px", cursor: "pointer", backgroundColor: isConnected ? "#ff4d4f" : "#1890ff", color: "white", border: "none", padding: "10px", borderRadius: "4px", fontWeight: "bold", fontSize: "14px", width: "100%", transition: "background-color 0.2s" }}>
            {isConnected ? "断开连接" : "打开串口"}
          </button>
        </div>
      </div>

      {/* 快捷执行面板 */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", backgroundColor: "#fafafa" }}>
        <div style={{ padding: "12px 15px", borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: "bold", color: "#333", fontSize: "14px" }}>🚀 快捷指令</span>
          <button onClick={() => setShowCmdModal(true)} style={{ cursor: "pointer", background: "none", border: "1px solid #d9d9d9", borderRadius: "4px", padding: "4px 8px", fontSize: "12px", backgroundColor: "#fff" }}>⚙️ 设置</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
          {quickCommands.length === 0 && <div style={{textAlign: "center", color: "#aaa", fontSize: "12px", marginTop: "20px"}}>暂无快捷指令</div>}
          {quickCommands.map((cmd) => (
            <button key={cmd.id} onClick={() => executeSend(cmd.data, cmd.isHex, true)} disabled={!isConnected} title={cmd.data} style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "8px 10px", borderRadius: "6px", border: "1px solid #ddd", background: "#fff", cursor: isConnected ? "pointer" : "not-allowed", opacity: isConnected ? 1 : 0.6, textAlign: "left" }}>
              <div style={{ fontWeight: "bold", fontSize: "13px", color: "#333" }}>{cmd.name} {cmd.isHex && <span style={{ color: "#e91e63", fontSize: "10px", marginLeft: "4px", border: "1px solid #f8bbd0", padding: "0 2px", borderRadius: "2px" }}>HEX</span>}</div>
              <div style={{ fontSize: "11px", color: "#888", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", width: "100%" }}>{cmd.data}</div>
            </button>
          ))}
        </div>
      </div>

      {/* 快捷指令设置窗口 */}
      {showCmdModal && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.5)", zIndex: 9999, display: "flex", justifyContent: "center", alignItems: "center", backdropFilter: "blur(2px)" }}>
          <div style={{ width: "600px", height: "550px", backgroundColor: "#fff", borderRadius: "10px", display: "flex", flexDirection: "column", boxShadow: "0 10px 30px rgba(0,0,0,0.2)", overflow: "hidden" }}>
            <div style={{ padding: "15px 20px", borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between", alignItems: "center", backgroundColor: "#f9f9f9" }}>
              <h3 style={{ margin: 0, color: "#333", fontSize: "16px" }}>⚙️ 快捷指令管理</h3>
              <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                <button onClick={exportCommands} style={{ cursor: "pointer", background: "none", border: "1px solid #ccc", borderRadius: "4px", padding: "4px 10px", fontSize: "12px", backgroundColor: "#fff" }}>导出 JSON</button>
                <button onClick={() => fileInputRef.current?.click()} style={{ cursor: "pointer", background: "none", border: "1px solid #ccc", borderRadius: "4px", padding: "4px 10px", fontSize: "12px", backgroundColor: "#fff" }}>导入 JSON</button>
                <input type="file" accept=".json" style={{ display: "none" }} ref={fileInputRef} onChange={importCommands} />
                <button onClick={() => setShowCmdModal(false)} style={{ cursor: "pointer", background: "none", border: "none", fontSize: "18px", color: "#999", marginLeft: "10px" }} title="关闭">✖</button>
              </div>
            </div>
            <div style={{ padding: "10px 20px", borderBottom: "1px solid #eee" }}>
              <input type="text" value={quickCmdSearch} onChange={(e) => setQuickCmdSearch(e.target.value)} placeholder="🔍 搜索已有指令..." style={{ width: "100%", padding: "8px 12px", borderRadius: "4px", border: "1px solid #ddd", boxSizing: "border-box", outline: "none", fontSize: "13px" }} />
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "20px", display: "flex", flexDirection: "column", gap: "10px", backgroundColor: "#fafafa" }}>
              {quickCommands.filter(c => c.name.toLowerCase().includes(quickCmdSearch.toLowerCase()) || c.data.toLowerCase().includes(quickCmdSearch.toLowerCase())).map((cmd) => (
                <div key={cmd.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", backgroundColor: "#fff", border: "1px solid #e0e0e0", borderRadius: "6px", padding: "12px", boxShadow: "0 1px 3px rgba(0,0,0,0.02)" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "5px", flex: 1, marginRight: "15px" }}>
                    <div style={{ fontWeight: "bold", color: "#333", fontSize: "14px", display: "flex", alignItems: "center", gap: "6px" }}>{cmd.name} {cmd.isHex && <span style={{ backgroundColor: "#e91e63", color: "white", fontSize: "10px", padding: "1px 4px", borderRadius: "3px" }}>HEX</span>}</div>
                    <div style={{ fontSize: "13px", color: "#666", fontFamily: "monospace", wordBreak: "break-all" }}>{cmd.data}</div>
                  </div>
                  <button onClick={() => setQuickCommands(prev => prev.filter(c => c.id !== cmd.id))} style={{ background: "#fff1f0", color: "#ff4d4f", cursor: "pointer", fontSize: "13px", padding: "6px 12px", borderRadius: "4px", border: "1px solid #ffa39e" }}>删除</button>
                </div>
              ))}
            </div>
            <div style={{ padding: "15px 20px", borderTop: "1px solid #ddd", display: "flex", flexDirection: "column", gap: "10px", backgroundColor: "#fff" }}>
              <div style={{ fontSize: "14px", fontWeight: "bold", color: "#555" }}>➕ 添加新指令</div>
              <div style={{ display: "flex", gap: "10px" }}>
                <input type="text" value={newCmdName} onChange={(e) => setNewCmdName(e.target.value)} placeholder="指令名称 (如: 重启)" style={{ flex: 1, padding: "8px", border: "1px solid #ccc", borderRadius: "4px", fontSize: "13px" }} />
                <label style={{ display: "flex", alignItems: "center", gap: "5px", color: newCmdIsHex ? "#e91e63" : "#666", fontSize: "13px", cursor: "pointer" }}><input type="checkbox" checked={newCmdIsHex} onChange={(e) => setNewCmdIsHex(e.target.checked)} />HEX格式</label>
              </div>
              <div style={{ display: "flex", gap: "10px", alignItems: "flex-end" }}>
                <textarea value={newCmdData} onChange={(e) => setNewCmdData(e.target.value)} placeholder="指令内容..." style={{ flex: 1, padding: "8px", border: "1px solid #ccc", borderRadius: "4px", fontSize: "13px", resize: "none", height: "40px", fontFamily: "monospace" }} />
                <button onClick={addQuickCommand} style={{ backgroundColor: "#52c41a", color: "white", border: "none", borderRadius: "4px", padding: "0 20px", height: "58px", fontSize: "14px", cursor: "pointer", fontWeight: "bold" }}>保存添加</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
