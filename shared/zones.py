def get_zone(lat, lon):
    if lat is None or lon is None:
        return "unknown"

    if 35.0 <= lat <= 42.0 and -6.0 <= lon <= 0.0:
        return "gibraltar"
    if 35.0 <= lat <= 40.0 and 0.0 <= lon <= 5.0:
        return "alboran"
    if 37.0 <= lat <= 44.0 and 5.0 <= lon <= 15.0:
        return "balearic_tyrrhenian"
    if 38.0 <= lat <= 46.0 and 12.0 <= lon <= 22.0:
        return "adriatic"
    if 30.0 <= lat <= 38.0 and 9.0 <= lon <= 16.0:
        return "central_med"
    if 35.0 <= lat <= 42.0 and 19.0 <= lon <= 30.0:
        return "aegean"
    if 30.0 <= lat <= 42.0 and 26.0 <= lon <= 37.0:
        return "eastern_med"
    if 30.0 <= lat <= 48.0 and 27.0 <= lon <= 42.0:
        return "black_sea"
    return "other"