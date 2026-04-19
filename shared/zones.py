def get_zone(lat, lon):
    if lat is None or lon is None:
        return "unknown"

    # Mediterranean zones
    if 35.0 <= lat <= 42.0 and -6.0 <= lon <= 0:
        return "gibraltar"
    if 36.0 <= lat <= 40.0 and 0 <= lon <= 5.0:
        return "alboran"
    if 37.0 <= lat <= 41.0 and 5.0 <= lon <= 12.0:
        return "balearic"
    if 36.0 <= lat <= 42.0 and 12.0 <= lon <= 20.0:
        return "central"
    if 35.0 <= lat <= 40.0 and 20.0 <= lon <= 27.0:
        return "eastern"
    if 30.0 <= lat <= 36.0 and 30.0 <= lon <= 37.0:
        return "levant"
    return "other"