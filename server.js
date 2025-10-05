import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();

// middleware
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 5000;

// Función para calcular probabilidad de lluvia basada en precipitación y humedad
function calculateRainProbability(precipitation, humidity, hours) {
  const rainHours = precipitation.filter(p => p > 0.1).length;
  const baseProbability = (rainHours / hours) * 100;
  
  // Ajustar por humedad si está disponible
  let humidityBonus = 0;
  if (humidity && humidity.length > 0) {
    const avgHumidity = humidity.reduce((a, b) => a + b, 0) / humidity.length;
    humidityBonus = avgHumidity > 80 ? 10 : (avgHumidity > 60 ? 5 : 0);
  }
  
  return Math.min(100, Math.round(baseProbability + humidityBonus));
}

// Función para evaluar temperatura
function evaluateTemperature(temperatures) {
  const avgTemp = temperatures.reduce((a, b) => a + b, 0) / temperatures.length;
  const maxTemp = Math.max(...temperatures);
  const minTemp = Math.min(...temperatures);
  
  let tempStatus = 'normal';
  if (maxTemp > 35) tempStatus = 'muy_alta';
  else if (minTemp < 0) tempStatus = 'muy_baja';
  else if (maxTemp > 30) tempStatus = 'alta';
  else if (minTemp < 5) tempStatus = 'baja';
  
  return {
    average: Math.round(avgTemp * 10) / 10,
    max: Math.round(maxTemp * 10) / 10,
    min: Math.round(minTemp * 10) / 10,
    status: tempStatus
  };
}

// Función para evaluar viento
function evaluateWind(windSpeeds) {
  const avgWind = windSpeeds.reduce((a, b) => a + b, 0) / windSpeeds.length;
  const maxWind = Math.max(...windSpeeds);
  
  let windStatus = 'Poco';
  if (maxWind > 20) windStatus = 'Mucho';
  else if (avgWind > 10) windStatus = 'Común';
  
  return {
    average: Math.round(avgWind * 10) / 10,
    max: Math.round(maxWind * 10) / 10,
    status: windStatus
  };
}

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
      hourly: 'precipitation,temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m',
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

    if (!data.hourly || !data.hourly.time || !data.hourly.precipitation || !data.hourly.temperature_2m || !data.hourly.wind_speed_10m) {
      return res.status(502).json({ error: 'unexpected weather data format' });
    }

    const times = data.hourly.time.map(t => new Date(t));
    const precs = data.hourly.precipitation.map(Number);
    const temps = data.hourly.temperature_2m.map(Number);
    const humidity = data.hourly.relative_humidity_2m ? data.hourly.relative_humidity_2m.map(Number) : null;
    const windSpeed = data.hourly.wind_speed_10m.map(Number);
    const windDirection = data.hourly.wind_direction_10m ? data.hourly.wind_direction_10m.map(Number) : null;

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
      const temp = temps[idx] ?? 0;
      const willRain = precip >= threshNum;
      
      // Calcular probabilidad de lluvia para el período
      const window = 6; // horas de contexto
      const start = Math.max(0, idx - window);
      const end = Math.min(times.length, idx + window + 1);
      const contextPrecs = precs.slice(start, end);
      const contextTemps = temps.slice(start, end);
      const contextHumidity = humidity ? humidity.slice(start, end) : null;
      const contextWindSpeed = windSpeed.slice(start, end);
      
      const rainProbability = calculateRainProbability(contextPrecs, contextHumidity, end - start);
      const temperatureData = evaluateTemperature(contextTemps);
      const windData = evaluateWind(contextWindSpeed);
      
      const points = [];
      for (let i = start; i < end; i++) {
        points.push({ 
          time: times[i].toISOString(), 
          precipitation: precs[i],
          temperature: temps[i],
          humidity: humidity ? humidity[i] : null,
          windSpeed: windSpeed[i],
          windDirection: windDirection ? windDirection[i] : null
        });
      }

      return res.json({
        mode: 'specific_date',
        requestedDate: targetDate.toISOString(),
        willRain,
        rainProbability,
        precipitationMm: precip,
        temperature: temp,
        temperatureData,
        windData,
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
    const sliceTemps = temps.slice(startIdx, startIdx + hoursNum);
    const sliceHumidity = humidity ? humidity.slice(startIdx, startIdx + hoursNum) : null;
    const sliceWindSpeed = windSpeed.slice(startIdx, startIdx + hoursNum);
    
    const points = sliceTimes.map((t, i) => ({ 
      time: t.toISOString(), 
      precipitation: slicePrecs[i],
      temperature: sliceTemps[i],
      humidity: sliceHumidity ? sliceHumidity[i] : null,
      windSpeed: sliceWindSpeed[i],
      windDirection: windDirection ? windDirection[startIdx + i] : null
    }));
    
    const maxPrecip = points.reduce((m, p) => (p.precipitation > m ? p.precipitation : m), 0);
    const willRain = points.some(p => p.precipitation >= threshNum);
    
    // Calcular probabilidad de lluvia y datos de temperatura
    const rainProbability = calculateRainProbability(slicePrecs, sliceHumidity, hoursNum);
    const temperatureData = evaluateTemperature(sliceTemps);
    const windData = evaluateWind(sliceWindSpeed);

    return res.json({
      mode: 'next_hours',
      willRain,
      rainProbability,
      maxPrecipitationMm: maxPrecip,
      temperatureData,
      windData,
      hoursAnalyzed: points.length,
      thresholdMm: threshNum,
      points,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal error' });
  }
});
