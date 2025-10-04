import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();

// middleware
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 5000;

app.get('/', (req, res) => {
  res.send('¡Hola! El servidor Express funciona.');
});

// Proxy simple a Open-Meteo
// Parámetros de consulta: lat, lon, start, end
app.get('/api/weather', async (req, res) => {
  try {
    const { lat, lon, start, end } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: 'lat and lon are required' });

    const params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      hourly: 'precipitation,temperature_2m',
      timezone: 'auto',
    });
    if (start) params.set('start_date', start);
    if (end) params.set('end_date', end);

    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;

    const resp = await fetch(url);
    if (!resp.ok) return res.status(resp.status).json({ error: 'weather provider error' });
    const data = await resp.json();
    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

// Endpoint que responde si va a llover en una fecha/hora específica o en las próximas N horas
// Query params:
// - lat (required), lon (required)
// - date (optional, ISO 8601 string). Si se proporciona, se devolverá el análisis para esa hora exacta (si está disponible).
// - hours (optional, default 12) -> si no hay `date`, analizará las próximas N horas
// - threshold (mm, optional default 0.1)
app.get('/api/willitrain', async (req, res) => {
  try {
    const { lat, lon, date, hours = '12', threshold = '0.1' } = req.query;
    const hoursNum = Math.max(1, Math.min(168, parseInt(hours, 10) || 12));
    const threshNum = parseFloat(threshold) || 0.1;
    if (!lat || !lon) return res.status(400).json({ error: 'lat and lon are required' });

    // Si el cliente pide una fecha específica, usaremos start_date/end_date para solicitar el día correspondiente.
    let params = new URLSearchParams({
      latitude: lat,
      longitude: lon,
      hourly: 'precipitation',
      timezone: 'auto',
    });

    let targetDate = null;
    if (date) {
      // intentar parsear fecha/hora ISO
      const d = new Date(date);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'invalid date' });
      targetDate = d;
      // Pedimos el día completo para asegurarnos de tener la hora solicitada
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      params.set('start_date', `${yyyy}-${mm}-${dd}`);
      params.set('end_date', `${yyyy}-${mm}-${dd}`);
    } else {
      // Sin fecha: pedimos suficientes horas (Open-Meteo acepta start/end por fecha; para 'forecast' default se devuelve futuro)
      // Pediremos el rango por defecto (no start/end) y luego tomaremos las próximas hoursNum horas desde 'now'.
    }

    const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
    const resp = await fetch(url);
    if (!resp.ok) return res.status(resp.status).json({ error: 'weather provider error' });
    const data = await resp.json();

    if (!data.hourly || !data.hourly.time || !data.hourly.precipitation) {
      return res.status(502).json({ error: 'unexpected weather data format' });
    }

    const times = data.hourly.time.map(t => new Date(t));
    const precs = data.hourly.precipitation.map(Number);

    if (targetDate) {
      // buscar el índice con la hora más cercana al targetDate
      let idx = times.findIndex(t => t.getTime() === targetDate.getTime());
      if (idx === -1) {
        // buscar el más cercano
        let minDiff = Infinity;
        idx = -1;
        for (let i = 0; i < times.length; i++) {
          const diff = Math.abs(times[i].getTime() - targetDate.getTime());
          if (diff < minDiff) { minDiff = diff; idx = i; }
        }
      }

      const precip = precs[idx] ?? 0;
      const willRain = precip >= threshNum;
      // devolver el punto objetivo y contexto (unas horas anteriores y posteriores)
      const window = 6; // horas de contexto
      const start = Math.max(0, idx - window);
      const end = Math.min(times.length, idx + window + 1);
      const points = [];
      for (let i = start; i < end; i++) points.push({ time: times[i].toISOString(), precipitation: precs[i] });

      return res.json({
        mode: 'specific_date',
        requestedDate: targetDate.toISOString(),
        willRain,
        precipitationMm: precip,
        thresholdMm: threshNum,
        contextHours: points,
      });
    }

    // Sin fecha: analizar próximas hoursNum horas desde ahora
    const now = new Date();
    let startIdx = times.findIndex(t => t >= now);
    if (startIdx === -1) startIdx = times.length - 1;
    const sliceTimes = times.slice(startIdx, startIdx + hoursNum);
    const slicePrecs = precs.slice(startIdx, startIdx + hoursNum);
    const points = sliceTimes.map((t, i) => ({ time: t.toISOString(), precipitation: slicePrecs[i] }));
    const maxPrecip = points.reduce((m, p) => (p.precipitation > m ? p.precipitation : m), 0);
    const willRain = points.some(p => p.precipitation >= threshNum);

    return res.json({
      mode: 'next_hours',
      willRain,
      maxPrecipitationMm: maxPrecip,
      hoursAnalyzed: points.length,
      thresholdMm: threshNum,
      points,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});
