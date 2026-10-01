import { Ltr, Table, Td, Th } from '@khalta/ui';
import { useFormat } from '../lib/format';
import type { TableDefinition } from './api';

/** Read-only view of a design-aid / lookup table (e.g. ACI 211.1 grids). Numbers stay LTR and end-aligned. */
export function TableGrid({ def }: { def: TableDefinition }) {
  const f = useFormat();
  const n = (v: number | null) => (v === null ? '—' : f.number(v, { maximumFractionDigits: 4 }));
  return (
    <div className="overflow-x-auto">
      <Table>
        <thead>
          <tr>
            <Th>
              <Ltr mono>{def.rows ? `${def.rows.name} \\ ${def.cols.name}` : def.cols.name}</Ltr>
            </Th>
            {def.cols.values.map((c) => (
              <Th key={c} numeric>
                <Ltr>{n(c)}</Ltr>
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {def.data.map((row, i) => {
            const label = def.rows ? def.rows.values[i]! : null;
            return (
              <tr key={i}>
                <Td>
                  <Ltr>
                    {label === null
                      ? ''
                      : Array.isArray(label)
                        ? `${n(label[0])}–${n(label[1])}`
                        : n(label)}
                  </Ltr>
                </Td>
                {row.map((cell, j) => (
                  <Td key={j} numeric>
                    <Ltr>{n(cell)}</Ltr>
                  </Td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
