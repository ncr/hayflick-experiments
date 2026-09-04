// Reinforced concrete material, shared verbatim by GLSL and Metal.
// CFN and vector aliases are supplied by the embedding backend.
// Units: world metres approximately; pixel footprint filters smaller detail.
struct ConcreteSurface { vec3 albedo; vec3 normal; float roughness; float metallic; };
CFN float cnHash(vec3 p) {
    p=fract(p*0.1031); p+=dot(p,p.yzx+33.33);
    return fract((p.x+p.y)*p.z);
}
CFN float cnNoise(vec3 p) {
    vec3 i=floor(p), f=fract(p);f=f*f*(3.0-2.0*f);
    return mix(mix(mix(cnHash(i),cnHash(i+vec3(1,0,0)),f.x),
                   mix(cnHash(i+vec3(0,1,0)),cnHash(i+vec3(1,1,0)),f.x),f.y),
               mix(mix(cnHash(i+vec3(0,0,1)),cnHash(i+vec3(1,0,1)),f.x),
                   mix(cnHash(i+vec3(0,1,1)),cnHash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
CFN float cnFbm(vec3 p) {
    return 0.57*cnNoise(p)+0.29*cnNoise(p*2.07+19.3)+0.14*cnNoise(p*4.13+7.1);
}
struct ConcreteGrain { float amount; float shade; vec2 slope; };
CFN ConcreteGrain cnGravel(vec2 uv,float seed,float footprint) {
    vec2 cell=floor(uv), f=fract(uv);
    float best=8.0, shade=0.0;vec2 direction=vec2(0.0);
    for (int y=-1;y<=1;y++) for(int x=-1;x<=1;x++) {
        vec2 g=vec2(float(x),float(y));
        float a=cnHash(vec3(cell+g,seed));
        vec2 center=vec2(a,cnHash(vec3(cell+g,seed+7.0)))*0.64+0.18;
        vec2 d=f-g-center;
        // Crushed angular aggregate: intersect oblique slabs, not circles.
        float angle=a*6.2831853;vec2 q=vec2(d.x*cos(angle)-d.y*sin(angle),d.x*sin(angle)+d.y*cos(angle));
        float distance=max(max(abs(q.x)*1.1,abs(q.y)*1.45),abs(q.x+q.y)*0.85);
        distance-=0.12+0.18*cnHash(vec3(cell+g,seed+23.0));
        if(distance<best){best=distance;shade=a;direction=d;}
    }
    ConcreteGrain outG;
    outG.amount=1.0-smoothstep(-footprint,footprint,best);
    outG.shade=shade;outG.slope=direction;
    return outG;
}
CFN ConcreteSurface concreteSurface(vec3 p,vec3 gn,vec2 uv,float code,float seed,float footprint) {
    int kind=int(code)/8;int history=int(code)-kind*8;
    ConcreteSurface s;s.normal=gn;s.roughness=0.87;s.metallic=0.0;
    if(kind==3) {
        // Continuous dusty industrial paving; exposed stone and subtle slab
        // joints. No grass classifier, checker, or legacy porcelain effect.
        float dirt=cnFbm(vec3(p.xz*0.8,seed));
        s.albedo=mix(vec3(0.09,0.088,0.076),vec3(0.235,0.216,0.177),dirt);
        s.albedo*=0.93+0.12*cnNoise(p*14.0);
        vec2 joint=abs(fract(p.xz/2.0+0.5)-0.5)*2.0;
        float seam=1.0-smoothstep(0.007,0.007+footprint,min(joint.x,joint.y));
        s.albedo*=1.0-seam*0.19;
        s.roughness=0.96;return s;
    }
    vec3 an=abs(gn);
    // Mapping follows geometry's dominant face; UV.x is interpolated physical
    // cover loss, so all causes know where the original skin actually survives.
    vec2 q=an.y>0.65?p.xz:(an.x>an.z?p.zy:p.xy);
    vec3 tangent=an.y>0.65?vec3(1,0,0):(an.x>an.z?vec3(0,0,1):vec3(1,0,0));
    vec3 bitangent=an.y>0.65?vec3(0,0,1):vec3(0,1,0);
    float macro=cnFbm(p*0.85+seed);
    float grit=cnNoise(p*35.0+seed*0.3);
    float microVis=1.0-smoothstep(0.015,0.07,footprint);
    if(kind==1) {
        // Steel cores remain dark graphite; porous layered iron oxide has
        // low metallic response and interrupts the exposed metal sheen.
        float oxide=smoothstep(0.27,0.66,cnFbm(p*9.0+seed));
        vec3 rust=mix(vec3(0.035,0.014,0.006),vec3(0.22,0.078,0.018),macro);
        s.albedo=mix(vec3(0.11,0.12,0.115),rust,oxide);
        s.albedo*=0.52+0.20*grit;
        s.roughness=mix(0.40,0.93,oxide);s.metallic=1.0-oxide*0.97;
        return s;
    }
    float exposed=kind==2?1.0:smoothstep(0.015,0.065,uv.x);
    ConcreteGrain grain=cnGravel(q*15.0,seed,clamp(footprint*15.0*0.55,0.02,0.45));
    float mineral=grain.amount*(0.065+0.935*exposed);
    vec3 paste=mix(vec3(0.18,0.183,0.17),vec3(0.305,0.302,0.275),macro);
    vec3 stone=mix(vec3(0.055,0.062,0.057),vec3(0.30,0.295,0.27),grain.shade);
    s.albedo=mix(paste,stone,mineral*0.92);
    s.albedo*=1.0+(grit-0.5)*0.14*microVis;
    float pore=pow(max(0.0,cnNoise(p*22.0+97.0)-0.38)*1.7,3.0);
    s.albedo*=1.0-min(0.22,pore)*(1.0-smoothstep(0.025,0.09,footprint));
    // Distinct fracture faces: rough aggregate protrudes from the binder.
    s.normal=normalize(gn+(tangent*grain.slope.x+bitangent*grain.slope.y)*exposed*grain.amount*0.85);
    float skin=1.0-exposed;
    if(kind==0) {
        // Casting history only survives where the original face survives:
        // faint lift joints, timber grain and recessed form-tie holes.
        float lift=abs(fract(p.y/0.62+0.5)-0.5)*0.62;
        float seam=1.0-smoothstep(0.008,0.008+footprint,lift);
        float boards=cnNoise(vec3(q.x*1.4,q.y*32.0,seed+31.0));
        s.albedo*=1.0-skin*(seam*0.15+(boards-0.3)*0.06);
        vec2 tie=fract(q/vec2(1.1,0.62)+0.5)-0.5;
        float hole=1.0-smoothstep(0.018,0.025+footprint,length(tie*vec2(1.1,0.62)));
        s.albedo*=1.0-hole*skin*0.55;
        s.albedo*=1.0-clamp(uv.y,0.0,1.0)*0.58*skin;
    }
    if(history==1 || history==2) {
        // Gravity transport. A slowly wandering path has one persistent
        // upstream source, and a wet foot is distinct from dry white leachate.
        float flow=cnNoise(vec3(q.x*7.0+0.5*cnNoise(p*1.2),q.y*0.45,seed+13.0));
        float wash=smoothstep(0.43,0.75,flow);
        float damp=(1.0-smoothstep(0.12,0.95,p.y))*smoothstep(0.25,0.62,macro);
        s.albedo*=1.0-wash*0.22-damp*0.26;
        float chalk=smoothstep(0.64,0.79,flow)*smoothstep(0.4,1.3,p.y)*skin;
        s.albedo=mix(s.albedo,vec3(0.44,0.445,0.415),chalk*0.45);
        s.roughness=mix(0.92,0.72,damp);
    }
    if(history==2 || history==4) {
        // Oxide travels from the actual exposed reinforcement plane, then
        // collects at the lower ragged cover lip. It is not an all-wall tint.
        float nearSteel=exp(-pow((uv.x-0.055)/0.027,2.0));
        float bleed=nearSteel*(0.3+0.7*cnFbm(vec3(q*vec2(6.0,0.7),seed+29.0)));
        s.albedo=mix(s.albedo,vec3(0.205,0.075,0.021),bleed*0.73);
    }
    if(history==3 || history==4) {
        // Smoke rises in broad plumes. Char deposition and heat-altered
        // cement are separate masks; newly broken stone stays readable.
        float plume=cnFbm(vec3(q*vec2(1.0,0.35),seed+8.0));
        float scorch=smoothstep(0.34,0.62,plume+0.12*smoothstep(0.4,2.8,p.y));
        float soot=scorch*(history==3?0.92:0.65)*(1.0-exposed*0.65);
        vec3 heated=mix(s.albedo,vec3(0.25,0.18,0.135),smoothstep(0.4,0.65,macro)*0.3);
        s.albedo=mix(heated,vec3(0.027,0.029,0.027),soot);
        // Connected heat crazing uses the same aggregate-scale domain with a
        // coarser cellular boundary and footprint-aware coverage.
        ConcreteGrain heatGrain=cnGravel(q*4.0,seed+83.0,max(0.025,footprint*4.0));
        float fissure=4.0*heatGrain.amount*(1.0-heatGrain.amount);
        s.albedo*=1.0-fissure*0.18*scorch*skin;
        s.roughness=0.97;
    }
    return s;
}
