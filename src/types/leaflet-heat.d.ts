// leaflet.heat ships no types of its own and attaches `heatLayer` to the
// global L at import time; this mirrors the plugin's documented options.
import "leaflet";

declare module "leaflet" {
  interface HeatLayerOptions {
    pane?: string;
    minOpacity?: number;
    maxZoom?: number;
    max?: number;
    radius?: number;
    blur?: number;
    gradient?: Record<number, string>;
  }
  interface HeatLayer extends Layer {
    setLatLngs(latlngs: Array<[number, number, number] | [number, number]>): this;
    addLatLng(latlng: [number, number, number] | [number, number]): this;
    setOptions(options: HeatLayerOptions): this;
    redraw(): this;
  }
  function heatLayer(latlngs: Array<[number, number, number] | [number, number]>, options?: HeatLayerOptions): HeatLayer;
}

