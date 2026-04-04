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
  trail: { el: number; az: number }[]; // 保存历史轨迹点
}

interface PositionData {
  fix: boolean;      // 定位状态
  lat: string;       // 纬度
  lon: string;       // 经度
  alt: string;       // 海拔
  satCount: number;  // 参与定位卫星数
  time: string;      // UTC 时间
  date: string;      // UTC 日期
  speed: string;     // 速度 (km/h)
  course: string;    // 航向 (度)
  hdop: string;      // 水平精度因子
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
    fix: false, lat: "0.000000", lon: "0.000000", alt: "0.0", satCount: 0,
    time: "", date: "", speed: "0.0", course: "0.0", hdop: "0.0"
  });
  
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
        const talker = parts[0].slice(1, 3);
        const type = parts[0].slice(3);

        // 1. 解析 GGA (获取位置、海拔、时间、HDOP、卫星数)
        if (type === 'GGA' && parts.length > 14) {
          const fixQuality = parseInt(parts[6]) || 0;
          updatedPos.fix = fixQuality > 0;
          updatedPos.satCount = parseInt(parts[7]) || 0;
          updatedPos.hdop = parts[8] || updatedPos.hdop; // 提取 HDOP

          // 提取时间 (hhmmss.ss)
          const timeRaw = parts[1];
          if (timeRaw && timeRaw.length >= 6) {
            updatedPos.time = `${timeRaw.slice(0, 2)}:${timeRaw.slice(2, 4)}:${timeRaw.slice(4, 6)}`;
          }
          
          if (updatedPos.fix) {
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
            updatedPos.alt = parts[9] || updatedPos.alt;
          }
        }

        // 2. 解析 RMC (获取日期、速度、航向。RMC是推荐定位信息的缩写)
        if (type === 'RMC' && parts.length > 12) {
          const status = parts[2]; // A = 激活/有效, V = 无效
          
          // 即使未定位(V)，有时模块也会吐出 RTC 时间
          const timeRaw = parts[1];
          if (timeRaw && timeRaw.length >= 6) {
             updatedPos.time = `${timeRaw.slice(0, 2)}:${timeRaw.slice(2, 4)}:${timeRaw.slice(4, 6)}`;
          }
          const dateRaw = parts[9]; // ddmmyy
          if (dateRaw && dateRaw.length === 6) {
             updatedPos.date = `20${dateRaw.slice(4, 6)}-${dateRaw.slice(2, 4)}-${dateRaw.slice(0, 2)}`;
          }

          // 仅在定位有效时更新速度和航向
          if (status === 'A') {
            updatedPos.fix = true;
            // 提取速度: 原始单位是“节(knots)”，1节 ≈ 1.852 km/h
            const speedKnots = parseFloat(parts[7]);
            if (!isNaN(speedKnots)) {
              updatedPos.speed = (speedKnots * 1.852).toFixed(1);
            }
            // 提取航向: 度
            const courseDeg = parseFloat(parts[8]);
            if (!isNaN(courseDeg)) {
              updatedPos.course = courseDeg.toFixed(1);
            }
          }
        }

        // 3. 解析 GSV (获取可视卫星，包含轨迹更新)
        if (type === 'GSV' && parts.length >= 8) {
          for (let i = 4; i < parts.length - 3; i += 4) {
            const prn = parts[i];
            const el = parseFloat(parts[i + 1]);
            const az = parseFloat(parts[i + 2]);
            const snr = parseFloat(parts[i + 3]); 

            if (prn && !isNaN(el) && !isNaN(az)) {
              const key = `${talker}-${prn}`;
              const existingSat = satellites.get(key);
              
              const newTrail = existingSat ? [...existingSat.trail, { el, az }] : [{ el, az }];
              if (newTrail.length > 50) newTrail.shift();

              satellites.set(key, {
                sys: talker,
                prn,
                el,
                az,
                snr: isNaN(snr) ? 0 : snr,
                color: sysColors[talker] || "#94a3b8",
                trail: newTrail 
              });
              satMapUpdated = true;
            }
          }
        }
      }
    });

    setPosition(updatedPos);
    if (satMapUpdated) {
      setSatellites(new Map(satellites));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs]);

  const satArray = Array.from(satellites.values()).filter(s => s.snr > 0).sort((a, b) => b.snr - a.snr);

  return (
    <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "20px", height: "100%", boxSizing: "border-box", overflowY: "auto" }}>
      
      {/* 顶部仪表盘：采用了自适应网格(auto-fit)，数据多时会自动换行 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "15px" }}>
        <StatCard title="状态 (Status)" value={position.fix ? "3D 定位" : "未定位"} color={position.fix ? "#22c55e" : "#ef4444"} />
        <StatCard title="UTC 日期" value={position.date || "---"} />
        <StatCard title="UTC 时间" value={position.time || "---"} />
        <StatCard title="纬度 (Lat)" value={position.fix ? position.lat : "---"} />
        <StatCard title="经度 (Lon)" value={position.fix ? position.lon : "---"} />
        <StatCard title="海拔 (Alt)" value={position.fix ? `${position.alt} m` : "---"} />
        <StatCard title="速度 (Speed)" value={position.fix ? `${position.speed} km/h` : "---"} />
        <StatCard title="航向 (Course)" value={position.fix ? `${position.course}°` : "---"} />
        <StatCard title="精度因子 (HDOP)" value={position.fix ? position.hdop : "---"} />
        <StatCard title="可用卫星" value={position.satCount || "0"} />
      </div>

      <div style={{ display: "flex", gap: "20px", flex: 1, minHeight: "400px" }}>
        
        {/* 左侧：天空图 (Skyplot) 包含轨迹 */}
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
                  height: `${Math.min(sat.snr * 3, 100)}%`, 
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
    <div style={{ backgroundColor: "#fff", padding: "16px", borderRadius: "10px", boxShadow: "0 2px 10px rgba(0,0,0,0.05)" }}>
      <div style={{ fontSize: "13px", color: "#666", marginBottom: "6px" }}>{title}</div>
      <div style={{ fontSize: "20px", fontWeight: "bold", color }}>{value}</div>
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

      {/* 绘制卫星圆点及轨迹 */}
      {satellites.map((sat, i) => {
        const r = radius * (1 - sat.el / 90);
        const theta = (sat.az - 90) * (Math.PI / 180);
        const cx = center + r * Math.cos(theta);
        const cy = center + r * Math.sin(theta);

        const polylinePoints = sat.trail.map(p => {
          const pr = radius * (1 - p.el / 90);
          const pTheta = (p.az - 90) * (Math.PI / 180);
          const px = center + pr * Math.cos(pTheta);
          const py = center + pr * Math.sin(pTheta);
          return `${px},${py}`;
        }).join(' ');

        return (
          <g key={i}>
            {sat.trail.length > 1 && (
              <polyline 
                points={polylinePoints} 
                fill="none" 
                stroke={sat.color} 
                strokeWidth="1.5" 
                strokeOpacity="0.5" 
                strokeDasharray="3 3" 
              />
            )}
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
