// idempotent MongoDB initialization for ais_analytics
(function(){
  const d = db.getSiblingDB('ais_analytics');

  function ensureCollection(name) {
    if (!d.getCollectionNames().includes(name)) {
      d.createCollection(name);
      print('Created collection: ' + name);
    } else {
      print('Collection exists: ' + name);
    }
  }

  ensureCollection('zone_stats');
  ensureCollection('alerts');
  ensureCollection('route_segments');
  ensureCollection('zone_traffic_hourly');
  ensureCollection('zone_traffic_daily');
  ensureCollection('heatmap_tiles_p5');
  ensureCollection('heatmap_tiles_p6');

  // Indexes (idempotent)
  print('Creating indexes (if not present)...');
  d.zone_stats.createIndex({ zone: 1, recorded_at: -1 });
  d.zone_stats.createIndex({ recorded_at: -1 });

  d.alerts.createIndex({ timestamp: -1 });
  d.alerts.createIndex({ mmsi: 1, timestamp: -1 });

  d.route_segments.createIndex({ cell_from: 1, cell_to: 1 });
  d.zone_traffic_hourly.createIndex({ zone: 1, hour: -1 });
  d.zone_traffic_daily.createIndex({ zone: 1, date: -1 });
  d.heatmap_tiles_p5.createIndex({ cell: 1, date: -1 });
  d.heatmap_tiles_p6.createIndex({ cell: 1, date: -1 });

  print('MongoDB initialization completed.');
})();
