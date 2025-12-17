// src/WordSharePie.jsx
import {
    PieChart,
    Pie,
    Cell,
    Tooltip,
    ResponsiveContainer,
} from 'recharts';

const COLORS = [
    '#7a5af8',
    '#9b8cff',
    '#5fc4e8',
    '#8aa0d6',
    '#b7c5f5',
    '#cbd5f5',
    '#6f86d6',
    '#91a3ee',
];

function WordShareTooltip({ active, payload }) {
    if (!active || !payload || !payload.length) return null;

    const { name, value } = payload[0];

    return (
        <div
            style={{
                background: 'rgba(255,255,255,0.82)',
                border: '1px solid rgba(229,232,242,0.9)',
                borderRadius: 12,
                padding: '8px 10px',
                color: '#0f172a',
                fontSize: 13,
                boxShadow: '0 18px 36px rgba(15,23,42,0.16)',
                maxWidth: 260,
                backdropFilter: 'blur(12px)',
            }}
        >
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{name}</div>
            <div style={{ opacity: 0.75 }}>{value} words</div>
        </div>
    );
}

export default function WordSharePie({ data, colorMap }) {
    if (!data || data.length === 0) {
        return (
            <div style={{ fontSize: 12, opacity: 0.7 }}>
                No spoken words yet.
            </div>
        );
    }

    return (
        <div style={{ width: '100%', height: 180 }}>
            <ResponsiveContainer>
                <PieChart>
                    <Pie
                        data={data}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={40}
                        outerRadius={70}
                        paddingAngle={2}
                        stroke="none"
                    >
                        {data.map((entry, idx) => (
                            <Cell
                                key={entry.name}
                                fill={colorMap?.[entry.name] || COLORS[idx % COLORS.length]}
                            />
                        ))}
                    </Pie>

                    {/* Custom tooltip with light text */}
                    <Tooltip
                        content={<WordShareTooltip />}
                        cursor={{ stroke: 'rgba(148,163,184,0.3)', strokeWidth: 1 }}
                    />
                </PieChart>
            </ResponsiveContainer>
        </div>
    );
}
