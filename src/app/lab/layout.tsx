/** Лаборатория алгоритма сохраняет свой фон-сетку; витрина — ровная бумага. */
export default function LabLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen grid-paper">{children}</div>;
}
