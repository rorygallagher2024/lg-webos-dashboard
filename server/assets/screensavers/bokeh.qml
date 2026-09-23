/*
 * Bokeh screen saver: soft circles of light drifting in and out on black.
 *
 * Only the circles are drawn. It began as rain on a window, but the drop layer
 * drew nothing on a C2 (webOS 9.2) - a capture showed pure black where the
 * drops should be - so it went rather than cost time every frame for nothing.
 *
 * The same parts as the starfield - ImageParticle with a white image tinted
 * per group, which draws on both firmwares - so it is compiled
 * QtQuick.Particles with no per-frame JavaScript. Both images are drawn by
 * code, not borrowed.
 *
 * Kind to the panel: the circles drift and fade over tens of seconds, and the
 * background is black.
 */
import QtQuick 2.4
import QtQuick.Particles 2.0
import Eos.Window 0.1
import QtQuick.Window 2.2

WebOSWindow {
    id: win

    width: Screen.width > 0 ? Screen.width : 1920
    height: Screen.height > 0 ? Screen.height : 1080

    windowType: "_WEBOS_WINDOW_TYPE_SCREENSAVER"
    appId: "com.webos.app.screensaver"
    title: "Screen Saver"
    visible: true
    color: "black"

    property real unit: win.height / 1080

    // Dim or bright, written in when the screen saver is staged. Dim lowers
    // the colours themselves as well as the alpha, as the starfield does.
    property int level: __TVWEB_LEVEL__
    property real lightAlpha: level > 0 ? 0.42 : 0.22
    property color amber: level > 0 ? "#ffb04a" : "#8a6230"
    property color red:   level > 0 ? "#ff4a3a" : "#8a3228"
    property color cool:  level > 0 ? "#bfe0ff" : "#5c6f82"

    ParticleSystem {
        id: sys
        anchors.fill: parent
    }

    // Three colours of light, each its own group so the tint stays true.
    ImageParticle {
        system: sys
        groups: ["amber"]
        source: "bokeh.png"
        color: win.amber
        colorVariation: 0.08
        alpha: win.lightAlpha
        alphaVariation: 0.10
    }
    ImageParticle {
        system: sys
        groups: ["red"]
        source: "bokeh.png"
        color: win.red
        colorVariation: 0.05
        alpha: win.lightAlpha
        alphaVariation: 0.10
    }
    ImageParticle {
        system: sys
        groups: ["cool"]
        source: "bokeh.png"
        color: win.cool
        colorVariation: 0.05
        alpha: win.lightAlpha * 0.8
        alphaVariation: 0.10
    }

    // Each colour has its own band of the screen and pace of drift.
    Emitter {
        system: sys
        group: "amber"
        startTime: 20000
        x: -win.width * 0.05; y: win.height * 0.30
        width: win.width * 1.1; height: win.height * 0.70
        shape: RectangleShape { fill: true }
        emitRate: 0.7
        lifeSpan: 22000
        lifeSpanVariation: 6000
        size: Math.round(150 * win.unit)
        sizeVariation: Math.round(70 * win.unit)
        velocity: AngleDirection { angle: 0; angleVariation: 180; magnitude: Math.round(6 * win.unit) }
    }
    Emitter {
        system: sys
        group: "red"
        startTime: 20000
        x: -win.width * 0.05; y: win.height * 0.55
        width: win.width * 1.1; height: win.height * 0.40
        shape: RectangleShape { fill: true }
        emitRate: 0.35
        lifeSpan: 18000
        lifeSpanVariation: 5000
        size: Math.round(90 * win.unit)
        sizeVariation: Math.round(40 * win.unit)
        velocity: AngleDirection { angle: 180; angleVariation: 10; magnitude: Math.round(12 * win.unit) }
    }
    Emitter {
        system: sys
        group: "cool"
        startTime: 20000
        x: 0; y: win.height * 0.15
        width: win.width; height: win.height * 0.60
        shape: RectangleShape { fill: true }
        emitRate: 0.2
        lifeSpan: 24000
        lifeSpanVariation: 6000
        size: Math.round(110 * win.unit)
        sizeVariation: Math.round(50 * win.unit)
        velocity: AngleDirection { angle: 0; angleVariation: 180; magnitude: Math.round(4 * win.unit) }
    }
}
