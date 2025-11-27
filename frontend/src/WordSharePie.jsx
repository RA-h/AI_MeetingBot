// src/WordSharePie.jsx
import {
    PieChart,
    Pie,
    Cell,
    Tooltip,
    ResponsiveContainer,
} from 'recharts';

const COLORS = [
    '#38bdf8',
    '#a855f7',
    '#f97316',
    '#22c55e',
    '#e11d48',
    '#facc15',
    '#6366f1',
    '#14b8a6',
];

function WordShareTooltip({ active, payload }) {
    if (!active || !payload || !payload.length) return null;

    const { name, value } = payload[0];

    return (
        <div
            style={{
                background: '#020617',
                border: '1px solid rgba(148,163,184,0.6)',
                borderRadius: 12,
                padding: '8px 10px',
                color: '#e5e7eb',
                fontSize: 13,
                boxShadow: '0 10px 25px rgba(0,0,0,0.5)',
                maxWidth: 260,
            }}
        >
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{name}</div>
            <div style={{ opacity: 0.9 }}>{value} words</div>
        </div>
    );
}

export default function WordSharePie({ data }) {
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
                                fill={COLORS[idx % COLORS.length]}
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
