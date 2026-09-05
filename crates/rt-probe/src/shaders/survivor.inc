// Character surface detail in BIND coordinates: it follows the clothes when
// the actor walks or turns. No screen noise and no contour/visibility AA.
// texIndex -2..-16 are the compiled character's material slots, not textures.
CFN vec3 survivorAlbedo(vec3 color, vec2 uv, int slot, float footprint) {
    float broad=cnNoise(vec3(uv*vec2(28.0,19.0),11.7));
    float fine=cnNoise(vec3(uv*170.0,29.0));
    float visible=1.0-smoothstep(0.006,0.022,footprint);
    if((slot>=0 && slot<=1) || slot==3 || (slot>=4 && slot<=6)) {
        // Worn knees and seat have lost dye; twill remains subtle and
        // disappears when smaller than a texel. Soil collects above the boot.
        float knee=exp(-pow((uv.y-0.51)*13.0,2.0));
        float wear=knee*(0.4+0.6*broad);
        float dirt=(1.0-smoothstep(0.16,0.39,uv.y))*(0.3+0.7*broad);
        float twill=sin((uv.x*1.5+uv.y)*1900.0)*visible;
        color*=0.77+0.28*broad+0.035*twill;
        color=mix(color,color*vec3(1.22,1.15,1.06),wear*0.55);
        color=mix(color,color*vec3(0.76,0.66,0.51),dirt*0.60);
    } else if(slot==14) {
        // Broad compressed leather, broken grain and restrained abrasion.
        float crease=sin(uv.y*125.0+sin(uv.x*48.0)*1.8);
        float creaseVis=1.0-smoothstep(0.016,0.045,footprint);
        color*=0.73+0.36*broad+0.09*crease*creaseVis+0.08*(fine-0.5)*visible;
        float scuff=smoothstep(0.62,0.84,broad)*0.18;
        color=mix(color,vec3(0.10,0.083,0.060),scuff);
    } else if(slot==13) {
        // Yellow cloth appliques keep their identity under dust and abrasion.
        color*=0.84+0.20*broad+0.03*(fine-0.5)*visible;
    } else if(slot>=7 && slot<=9) {
        color*=0.95+0.10*broad+0.03*(fine-0.5)*visible;
    } else if(slot==10 || slot==11) {
        color*=0.88+0.24*broad;
    }
    return color;
}
