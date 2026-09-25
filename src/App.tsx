import { useCallback, useEffect, useState } from 'react';
import { Asistente } from './componentes/Asistente';
import { Encabezado } from './componentes/Encabezado';
import { OFERTA, PENSUM, cargar, guardar, preferenciasDe, reiniciar, solicitudesDe, type Estado } from './estado/estado';
import { generarHorarios } from './motor/generarHorarios';
import { Paso1Aprobadas } from './pantallas/Paso1Aprobadas';
import { Paso2Materias } from './pantallas/Paso2Materias';
import { Paso3Preferencias } from './pantallas/Paso3Preferencias';
import { Paso4Resultado } from './pantallas/Paso4Resultado';

function correrMotor(s: Estado, excluir: string[] = []) {
  return generarHorarios({
    solicitudes: solicitudesDe(s),
    oferta: OFERTA,
    pensum: PENSUM,
    preferencias: preferenciasDe(s),
    excluir,
  });
}

export default function App() {
  const [e, setE] = useState<Estado>(cargar);
  const set = useCallback((fn: (e: Estado) => Estado) => setE((s) => fn(s)), []);

  useEffect(() => { guardar(e); }, [e]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }); }, [e.paso]);

  const irA = (paso: Estado['paso']) => set((s) => ({ ...s, paso }));

  // desde el paso 3 se genera con el ranking tal como se ve: se descartan los ajustes de "¿Qué no te gustó?"
  const generar = () =>
    set((s0) => {
      const s = { ...s0, ajustes: {} };
      const r = correrMotor(s);
      return { ...s, paso: 4, opciones: r.opciones, avisos: r.avisos, opcion: 0, vistos: r.opciones.map((h) => h.id), ronda: 1 };
    });

  const otras = (cambios: (e: Estado) => Estado) =>
    set((s0) => {
      const s = cambios(s0);
      const r = correrMotor(s, s.vistos);
      if (!r.opciones.length) {
        return { ...s, avisos: ['Ya viste todas las combinaciones posibles con estas condiciones. Prueba quitando un candado o cambiando tus preferencias.'] };
      }
      return { ...s, opciones: r.opciones, avisos: r.avisos, opcion: 0, vistos: [...s.vistos, ...r.opciones.map((h) => h.id)], ronda: s.ronda + 1 };
    });

  return (
    <div className="app">
      <Encabezado paso={e.paso} irA={irA} alInicio={() => irA(1)} />
      <main style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {e.paso === 1 && <Paso1Aprobadas e={e} set={set} seguir={() => irA(2)} />}
        {e.paso === 2 && <Paso2Materias e={e} set={set} seguir={() => irA(3)} volver={() => irA(1)} />}
        {e.paso === 3 && <Paso3Preferencias e={e} set={set} generar={generar} volver={() => irA(2)} />}
        {e.paso === 4 && <Paso4Resultado e={e} set={set} otras={otras} volver={() => irA(3)} />}
      </main>
      <footer className="pie">
        Prototipo Hackatón CESA · Oferta {OFERTA.periodo} ({OFERTA.fuente === 'simulada' ? 'datos simulados' : 'datos reales'}) ·{' '}
        <button type="button" className="linkbtn" style={{ fontSize: 12 }} onClick={() => { if (confirm('¿Borrar todo y empezar de nuevo?')) setE(reiniciar()); }}>
          Empezar de nuevo
        </button>
      </footer>
      {e.paso >= 2 && <Asistente e={e} set={set} />}
    </div>
  );
}
