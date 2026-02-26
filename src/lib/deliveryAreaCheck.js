function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getAddressCoords(address = {}) {
  const lat =
    toNum(address?.lat) ??
    toNum(address?.latitude) ??
    toNum(address?.location?.lat) ??
    toNum(address?.location?.latitude);
  const lng =
    toNum(address?.lng) ??
    toNum(address?.longitude) ??
    toNum(address?.location?.lng) ??
    toNum(address?.location?.longitude);
  if (lat === null || lng === null) return null;
  return { lat, lng };
}

function haversineKm(a, b) {
  const toRad = d => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R * c;
}

export const DEFAULT_DELIVERY_AREAS = [
  {
    name: "Paarl",
    city: "paarl",
    stateProvinceRegion: "western cape",
    country: "south africa",
    postalPrefixes: ["762", "763", "764"]
  },
  {
    name: "Franschhoek",
    city: "franschhoek",
    stateProvinceRegion: "western cape",
    country: "south africa",
    postalPrefixes: ["769"]
  },
  {
    name: "Stellenbosch",
    city: "stellenbosch",
    stateProvinceRegion: "western cape",
    country: "south africa",
    postalPrefixes: ["759", "760", "761"]
  },
  {
    name: "Wellington",
    city: "wellington",
    stateProvinceRegion: "western cape",
    country: "south africa",
    postalPrefixes: ["765"]
  },
  {
    name: "Cape Town",
    city: "cape town",
    stateProvinceRegion: "western cape",
    country: "south africa",
    postalPrefixes: ["740", "744", "745", "746", "747", "748", "749", "750", "755", "770", "771", "772", "773", "774", "775", "776", "778", "779", "780", "788", "792", "794", "800", "805", "806"]
  },
  {
    name: "Blouberg",
    city: "blouberg",
    stateProvinceRegion: "western cape",
    country: "south africa",
    postalPrefixes: ["744"]
  },
  {
    name: "Strand",
    city: "strand",
    stateProvinceRegion: "western cape",
    country: "south africa",
    postalPrefixes: ["713", "714"]
  },
  {
    name: "Somerset West",
    city: "somerset west",
    stateProvinceRegion: "western cape",
    country: "south africa",
    postalPrefixes: ["712", "713"]
  },
  {
    name: "Klapmuts",
    city: "klapmuts",
    stateProvinceRegion: "western cape",
    country: "south africa",
    postalPrefixes: ["7625", "762"]
  }
];

function areaMatchesAddress(address = {}, area = {}) {
  const city = normalize(address?.city);
  const region = normalize(address?.stateProvinceRegion || address?.province);
  const country = normalize(address?.country);
  const postalCode = normalize(address?.postalCode);
  const coords = getAddressCoords(address);

  const areaCity = normalize(area?.city);
  const areaRegion = normalize(area?.stateProvinceRegion || area?.province);
  const areaCountry = normalize(area?.country);
  const areaPostalPrefixes = Array.isArray(area?.postalPrefixes)
    ? area.postalPrefixes.map(normalize).filter(Boolean)
    : [];

  if (areaPostalPrefixes.length > 0 && postalCode) {
    const matchedPrefix = areaPostalPrefixes.some(prefix => postalCode.startsWith(prefix));
    if (matchedPrefix) return true;
  }

  if (areaCity && city && areaCity === city) {
    if (areaRegion && region && areaRegion !== region) return false;
    if (areaCountry && country && areaCountry !== country) return false;
    return true;
  }

  const centerLat = toNum(area?.center?.lat);
  const centerLng = toNum(area?.center?.lng);
  const radiusKm = toNum(area?.radiusKm);
  if (coords && centerLat !== null && centerLng !== null && radiusKm !== null) {
    const km = haversineKm(coords, { lat: centerLat, lng: centerLng });
    return km <= radiusKm;
  }

  return false;
}

export function evaluateDeliveryArea(address, serviceAreas = DEFAULT_DELIVERY_AREAS) {
  if (!address || typeof address !== "object") {
    return {
      supported: false,
      canPlaceOrder: false,
      reasonCode: "ADDRESS_MISSING",
      message: "Delivery address is required before placing an order.",
      matchedArea: null
    };
  }

  const areas = Array.isArray(serviceAreas) ? serviceAreas.filter(Boolean) : [];
  if (areas.length === 0) {
    return {
      supported: false,
      canPlaceOrder: false,
      reasonCode: "NO_SERVICE_AREAS_CONFIGURED",
      message: "No delivery service areas are configured.",
      matchedArea: null
    };
  }

  const postalCode = normalize(address?.postalCode);
  if (postalCode) {
    for (const area of areas) {
      const areaPostalPrefixes = Array.isArray(area?.postalPrefixes)
        ? area.postalPrefixes.map(normalize).filter(Boolean)
        : [];
      if (areaPostalPrefixes.some(prefix => postalCode.startsWith(prefix))) {
        return {
          supported: true,
          canPlaceOrder: true,
          reasonCode: "SUPPORTED",
          message: "Delivery address is within our current service area.",
          matchedArea: area?.name || area?.city || "configured_area"
        };
      }
    }

    return {
      supported: false,
      canPlaceOrder: false,
      reasonCode: "POSTAL_CODE_NOT_SUPPORTED",
      message:
        "Your postal code is currently outside our service area. Please use a supported delivery location.",
      matchedArea: null
    };
  }

  for (const area of areas) {
    if (areaMatchesAddress(address, area)) {
      return {
        supported: true,
        canPlaceOrder: true,
        reasonCode: "SUPPORTED",
        message: "Delivery address is within our current service area.",
        matchedArea: area?.name || area?.city || "configured_area"
      };
    }
  }

  return {
    supported: false,
    canPlaceOrder: false,
    reasonCode: "LOCATION_NOT_SUPPORTED",
    message:
      "Your delivery location is currently outside our service area. Please use a supported address.",
    matchedArea: null
  };
}
