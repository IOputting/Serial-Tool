import React, { useEffect, useState, useRef } from "react";
import { useSerialStore } from "../stores/useSerialStore";

// --- 类型定义 ---
interface Satellite {
  sys: string;  // GP(GPS), GL(GLONASS), BD/GB(北斗), GA(Galileo)
  prn: string;  // 卫星编号
  el: number;   // 仰角 (0-90)
  az: number;   // 方位角 (0-359)
  snr: number;  // 信噪比
  color: string;// 渲染颜色
}

interface PositionData {
  lat: string;
  lon: string;
  alt: string;
  fix: boolean;
  satCount: number;
}

const sysColors: Record<string, string> = {
  GP: "#3b82f6", // 蓝色 GPS
  GL: "#ef4444", // 红色 GLONASS
  GB: "#eab308", // 黄色 北斗
  BD: "#eab308", // 黄色 北斗
  GA: "#22c55e", // 绿色 Galileo
  GQ: "#a855f7", // 紫色 QZSS
};

export default function GNSSviewer() {
  const logs = useSerialStore((state) => state.logs);
  const lastParsedIndex = useRef(0);

  // --- 状态 ---
  const [position, setPosition] = useState<PositionData>({
    lat: "0.000000", lon: "0.000000", alt: "0.0", fix: false, satCount: 0
  });
  
  // 使用 Map 存储卫星，以系统+编号作为唯一键，方便更新
  const [satellites, setSatellites] = useState<Map<string, Satellite>>(new Map());

  // --- NMEA 解析逻辑 ---
  useEffect(() => {
    if (logs.length <= lastParsedIndex.current) return;

    const newLogs = logs.slice(lastParsedIndex.current);
    lastParsedIndex.current = logs.length;

    let updatedPos = { ...position };
    let satMapUpdated = false;

    newLogs.forEach(log => {
      if (log.isHex || log.type !== 'recv') return;

      const lines = log.text.split('\n');
      for (let line of lines) {
        line = line.trim();
        if (!line.startsWith('$')) continue;

        const parts = line.split('*')[0].split(',');
        const talker = parts[0].slice(1, 3); // 例如 GP, GL, GN
        const type = parts[0].slice(3);      // 例如 GGA, GSV, RMC

        // 1. 解析 GGA (获取位置和海拔)
        if (type === 'GGA' && parts.length > 14) {
          const fixQuality = parseInt(parts[6]) || 0;
          updatedPos.fix = fixQuality > 0;
          updatedPos.satCount = parseInt(parts[7]) || 0;
          
          if (updatedPos.fix) {
            // NMEA 经纬度转换: ddmm.mmmm -> dd.dddd
            const latRaw = parts[2];
            if (latRaw) {
              const latDeg = parseFloat(latRaw.substring(0, 2)) + parseFloat(latRaw.substring(2)) / 60;
              updatedPos.lat = (parts[3] === 'S' ? -latDeg : latDeg).toFixed(6);
            }
            const lonRaw = parts[4];
            if (lonRaw) {
              const lonDeg = parseFloat(lonRaw.substring(0, 3)) + parseFloat(lonRaw.substring(3)) / 60;
              updatedPos.lon = (parts[5] === 'W' ? -lonDeg : lonDeg).toFixed(6);
            }
            updatedPos.alt = parts[9] || "0.0";
          }
        }

        // 2. 解析 GSV (获取可视卫星，仰角，方位角，信噪比)
        if (type === 'GSV' && parts.length >= 8) {
          // 每条 GSV 语句最多包含 4 颗卫星的信息
          for (let i = 4; i < parts.length - 3; i += 4) {
            const prn = parts[i];
            const el = parseFloat(parts[i + 1]);
            const az = parseFloat(parts[i + 2]);
            const snr = parseFloat(parts[i + 3]); // 有些卫星可能没有信噪比

            if (prn && !isNaN(el) && !isNaN(az)) {
              const key = `${talker}-${prn}`;
              satellites.set(key, {
                sys: talker,
                prn,
                el,
                az,
                snr: isNaN(snr) ? 0 : snr,
                color: sysColors[talker] || "#94a3b8"
              });
              satMapUpdated = true;
            }
          }
        }
      }
    });

    setPosition(updatedPos);
    if (satMapUpdated) {
      // 触发 React 重新渲染 Map
      setSatellites(new Map(satellites));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs]);

  // 定期清理过期的卫星（如果在几秒钟内没有收到某颗卫星的 GSV）
  // 简易版：这里每次接收到数据就更新，复杂的系统里需要加 TTL 超时机制

  const satArray = Array.from(satellites.values()).filter(s => s.snr > 0).sort((a, b) => b.snr - a.snr);

  return (
    <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "20px", height: "100%", boxSizing: "border-box", overflowY: "auto" }}>
      
      {/* 顶部仪表盘：定位信息 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "15px" }}>
        <StatCard title="定位状态" value={position.fix ? "3D 定位" : "未定位"} color={position.fix ? "#22c55e" : "#ef4444"} />
        <StatCard title="纬度 (Lat)" value={position.fix ? position.lat : "---"} />
        <StatCard title="经度 (Lon)" value={position.fix ? position.lon : "---"} />
        <StatCard title="海拔 (Alt)" value={position.fix ? `${position.alt} m` : "---"} />
      </div>

      <div style={{ display: "flex", gap: "20px", flex: 1, minHeight: "400px" }}>
        
        {/* 左侧：天空图 (Skyplot) */}
        <div style={{ flex: 1, backgroundColor: "#fff", borderRadius: "10px", padding: "20px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <h3 style={{ margin: "0 0 20px 0", color: "#333" }}>🛰️ 卫星天空图</h3>
          <Skyplot satellites={satArray} />
        </div>

        {/* 右侧：信噪比柱状图 (SNR) */}
        <div style={{ flex: 2, backgroundColor: "#fff", borderRadius: "10px", padding: "20px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)", display: "flex", flexDirection: "column" }}>
          <h3 style={{ margin: "0 0 20px 0", color: "#333" }}>📊 信号强度 (C/N0) - 活跃卫星: {satArray.length}</h3>
          <div style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: "8px", overflowX: "auto", paddingBottom: "10px" }}>
            {satArray.map((sat, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "24px" }}>
                <span style={{ fontSize: "10px", color: "#666", marginBottom: "4px" }}>{sat.snr}</span>
                <div style={{ 
                  width: "16px", 
                  height: `${Math.min(sat.snr * 3, 100)}%`, // 将 SNR 映射到高度
                  backgroundColor: sat.color, 
                  borderRadius: "3px 3px 0 0",
                  transition: "height 0.3s ease"
                }}></div>
                <span style={{ fontSize: "10px", fontWeight: "bold", marginTop: "6px", color: sat.color }}>
                  {sat.sys}{sat.prn}
                </span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}

// --- 子组件：信息卡片 ---
function StatCard({ title, value, color = "#333" }: { title: string, value: string | number, color?: string }) {
  return (
    <div style={{ backgroundColor: "#fff", padding: "20px", borderRadius: "10px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)" }}>
      <div style={{ fontSize: "14px", color: "#666", marginBottom: "8px" }}>{title}</div>
      <div style={{ fontSize: "24px", fontWeight: "bold", color }}>{value}</div>
    </div>
  );
}

// --- 子组件：纯 SVG 天空图 ---
function Skyplot({ satellites }: { satellites: Satellite[] }) {
  const size = 300;
  const center = size / 2;
  const radius = size / 2 - 20;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {/* 背景与刻度圈 */}
      <circle cx={center} cy={center} r={radius} fill="#f8fafc" stroke="#cbd5e1" strokeWidth="2" />
      <circle cx={center} cy={center} r={radius * 0.66} fill="none" stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4 4" />
      <circle cx={center} cy={center} r={radius * 0.33} fill="none" stroke="#cbd5e1" strokeWidth="1" strokeDasharray="4 4" />
      <line x1={center} y1={20} x2={center} y2={size - 20} stroke="#cbd5e1" strokeWidth="1" />
      <line x1={20} y1={center} x2={size - 20} y2={center} stroke="#cbd5e1" strokeWidth="1" />
      
      {/* 东南西北标记 */}
      <text x={center} y={15} fontSize="12" textAnchor="middle" fill="#64748b">N</text>
      <text x={center} y={size - 5} fontSize="12" textAnchor="middle" fill="#64748b">S</text>
      <text x={size - 5} y={center + 4} fontSize="12" textAnchor="end" fill="#64748b">E</text>
      <text x={10} y={center + 4} fontSize="12" textAnchor="start" fill="#64748b">W</text>

      {/* 绘制卫星圆点 */}
      {satellites.map((sat, i) => {
        // 极坐标转笛卡尔坐标:
        // 仰角 90°在圆心，0°在边缘
        const r = radius * (1 - sat.el / 90);
        // NMEA方位角是以正北为0，顺时针。SVG中0度在右侧(X轴)。需要转换。
        const theta = (sat.az - 90) * (Math.PI / 180);
        
        const cx = center + r * Math.cos(theta);
        const cy = center + r * Math.sin(theta);

        return (
          <g key={i}>
            <circle cx={cx} cy={cy} r={8} fill={sat.color} stroke="#fff" strokeWidth="1" />
            <text x={cx} y={cy + 3} fontSize="8" fill="#fff" textAnchor="middle" fontWeight="bold">
              {sat.prn}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
