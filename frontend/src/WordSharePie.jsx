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
                    <Tooltip
                        contentStyle={{
                            background: '#020617',
                            border: '1px solid rgba(148,163,184,0.6)',
                            borderRadius: 8,
                            fontSize: 12,
                        }}
                        formatter={(value, name) => [`${value} words`, name]}
                    />
                </PieChart>
            </ResponsiveContainer>
        </div>
    );
}
