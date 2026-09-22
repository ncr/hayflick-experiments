// Ground, growth and moving blade intersections. Shared verbatim by GLSL/MSL.
// env4.w carries fixed simulation time + 1 while this environment is active.
CFN vec2 terrainParcel(vec2 p) {
    vec2 result=vec2(-1.0,0.0);
#define AREA(k,x0,z0,x1,z1,e) if(p.x>=float(x0)&&p.y>=float(z0)&&p.x<float(x1)&&p.y<float(z1)) result=vec2(float(k),float(e));
#include "../../../../assets/procedural/neighborhood.layout"
#undef AREA
    return result;
}
CFN float terrainBurn(vec2 p) {
    float burn=0.0;
#define AREA(k,x0,z0,x1,z1,e) if(k==3 && e==3) {vec2 q=max(max(vec2(float(x0),float(z0))-p,p-vec2(float(x1),float(z1))),vec2(0.0));burn=max(burn,1.0-smoothstep(0.25,2.0,length(q)));}
#include "../../../../assets/procedural/neighborhood.layout"
#undef AREA
    return burn;
}
CFN float terrainCrack(vec2 p) {
    float a=abs(p.y-(11.05+0.36*sin(p.x*0.67)+0.085*sin(p.x*4.7)));
    float b=abs(p.x-(7.4+0.62*sin(p.y*1.8)+0.065*sin(p.y*11.0)));
    float c=abs(p.x-(18.2+0.55*sin(p.y*1.4)+0.11*sin(p.y*7.0)));
    return min(a,min(b,c));
}
CFN float terrainRoadHeight(vec2 p) {
    float hole=max(clamp((1.0-length(p-vec2(8.3,11.8))/1.25)*3.0,0.0,1.0),
               max(clamp((1.0-length(p-vec2(19.0,13.5)))*3.0,0.0,1.0),
                   clamp((1.0-length(p-vec2(2.0,10.4))/0.8)*3.0,0.0,1.0)));
    return -0.012-hole*0.052;
}
CFN ConcreteSurface terrainSurface(vec3 p,vec3 gn,vec2 uv,float code,float footprint) {
    int kind=int(code)/8;ConcreteSurface s;s.normal=gn;s.roughness=0.96;s.metallic=0.0;
    float macro=cnFbm(p*1.3+17.0);float grit=cnNoise(p*43.0);
    if(kind==4) {
        float loss=smoothstep(0.015,0.055,uv.x);
        s.albedo=mix(vec3(0.027,0.028,0.026),vec3(0.076,0.073,0.062),macro);
        s.albedo*=0.76+0.48*grit;
        float crack=1.0-smoothstep(0.022,0.05+footprint,terrainCrack(p.xz));
        s.albedo=mix(s.albedo,vec3(0.012,0.013,0.010),crack*0.88);
        ConcreteGrain stone=cnGravel(p.xz*19.0,31.0,max(0.03,footprint*9.0));
        s.albedo=mix(s.albedo,mix(vec3(0.067,0.050,0.029),vec3(0.16,0.14,0.105),stone.shade),loss*0.8);
        // Worn centre paint belongs to the road, disappears in cracks/loss.
        float stripe=(1.0-smoothstep(0.035,0.045+footprint,abs(p.z-12.0)))*step(0.42,fract(p.x/3.2));
        float paint=stripe*smoothstep(0.25,0.70,cnNoise(p*18.0))*(1.0-loss)*(1.0-crack);
        s.albedo=mix(s.albedo,vec3(0.35,0.30,0.16),paint*0.65);
        return s;
    }
    if(kind==5) {
        float loss=smoothstep(0.012,0.06,uv.x);
        ConcreteGrain gravel=cnGravel(p.xz*16.0,61.0,max(0.025,footprint*8.0));
        s.albedo=mix(vec3(0.23,0.225,0.197),vec3(0.35,0.338,0.29),macro);
        s.albedo*=0.88+0.22*grit;
        s.albedo=mix(s.albedo,mix(vec3(0.085,0.076,0.056),vec3(0.25,0.23,0.18),gravel.shade),loss*gravel.amount);
        float crack=abs(sin(p.x*1.7+p.z*2.1+0.3*sin(p.x*9.0)));
        s.albedo*=1.0-(1.0-smoothstep(0.015,0.035+footprint,crack))*0.3;
        s.albedo=mix(s.albedo,vec3(0.038,0.036,0.028),terrainBurn(p.xz)*0.65*macro);
        return s;
    }
    // Uneven barren soil: fine dusty fines, compact growthes and dark pockets.
    s.albedo=mix(vec3(0.075,0.060,0.037),vec3(0.18,0.146,0.087),macro);
    s.albedo*=0.80+0.35*grit;
    float cover=smoothstep(0.40,0.65,cnNoise(vec3(p.xz*0.68,8.0)));
    s.albedo=mix(s.albedo,vec3(0.086,0.096,0.039),cover*0.23);
    s.albedo=mix(s.albedo,vec3(0.021,0.022,0.018),terrainBurn(p.xz)*(0.65+0.25*macro));
    return s;
}
struct GrassHit { float t; vec3 normal; vec3 color; };
// Finite tapered ribbons, intersected analytically in the material shader.
// This changes silhouette and depth, not just a wind tint or normal trick.
CFN float grassTriangle(vec3 o,vec3 d,vec3 a,vec3 b,vec3 c) {
    vec3 ab=b-a,ac=c-a;vec3 h=cross(d,ac);float det=dot(ab,h);
    if(abs(det)<0.0000001)return 1000.0;
    float inv=1.0/det;vec3 s=o-a;float u=dot(s,h)*inv;if(u<0.0||u>1.0)return 1000.0;
    vec3 q=cross(s,ab);float v=dot(d,q)*inv;if(v<0.0||u+v>1.0)return 1000.0;
    float t=dot(ac,q)*inv;return t>0.001?t:1000.0;
}
CFN GrassHit terrainGrass(vec3 o,vec3 d,float limit,float time,vec3 player) {
    GrassHit hit;hit.t=limit;hit.normal=vec3(0,1,0);hit.color=vec3(0.0);
    if(d.y>-0.12)return hit;
    float mid=(0.25-o.y)/d.y;
    if(mid>limit+1.2||mid<0.0)return hit;
    vec2 cell=floor((o+d*mid).xz/0.7);
    for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++) {
        vec2 c=cell+vec2(float(i),float(j));vec2 center=(c+0.5)*0.7;
        vec2 parcel=terrainParcel(center);int kind=int(parcel.x);
        if(kind<0||kind==2||kind==3)continue;
        float growth=cnNoise(vec3(center*0.68,8.0));
        if(kind==0&&growth<0.37)continue;
        if(kind==1&&terrainCrack(center)>0.48)continue;
        float burn=terrainBurn(center);
        float seed=cnHash(vec3(c,43.0));
        float tall=smoothstep(0.49,0.67,growth);
        float gust=0.6*sin(time*1.7-center.x*0.52-center.y*0.35)+0.4*sin(time*0.83+center.y*0.4);
        vec2 wind=vec2(0.83,0.55)*(0.10+0.13*gust);
        vec2 delta=center-player.xz;float dist=length(delta);
        float press=1.0-smoothstep(0.18,0.76,dist);
        vec2 bend=delta/max(dist,0.05)*press*0.38;
        for(int k=0;k<16;k++) {
            float r=cnHash(vec3(c,float(k)+31.0));
            if(r>1.0-burn*0.80)continue;
            vec2 root=(c+vec2(0.08)+vec2(r,cnHash(vec3(c,float(k)+71.0)))*0.84)*0.7;
            vec2 rp=terrainParcel(root);if(int(rp.x)!=kind)continue;
            if(kind==1&&terrainCrack(root)>0.085)continue;
            if(kind==0&&r>smoothstep(0.36,0.54,growth))continue;
            float height=(0.09+0.15*r+tall*(0.20+0.20*seed))*(kind==1?0.85:1.0);
            height*=1.0-press*0.72;
            float ground=kind==1?terrainRoadHeight(root):-0.068;
            vec2 rayMiddle=(o+d*((ground+height*0.5-o.y)/d.y)).xz;
            vec2 bound=abs(d.xz/d.y)*height*0.5+abs(wind*(0.4+height)+bend)+vec2(0.12);
            vec2 gap=abs(root-rayMiddle);
            if(gap.x>bound.x||gap.y>bound.y)continue;
            float angle=r*6.2831853;
            vec2 side=vec2(cos(angle),sin(angle));
            vec2 sway=wind*(0.4+height)+bend+side*(sin(time*3.4+r*20.0)*0.012);
            vec3 a=vec3(root.x,ground,root.y);
            vec3 b=a+vec3(sway.x*0.35,height*0.56,sway.y*0.35);
            vec3 tip=a+vec3(sway.x+side.x*0.075,height,sway.y+side.y*0.075);
            vec3 width=vec3(side.x,0.0,side.y)*(0.018+0.012*r);
            float t0=grassTriangle(o,d,a-width,a+width,b-width*0.52);
            float t1=grassTriangle(o,d,a+width,b+width*0.52,b-width*0.52);
            float t2=grassTriangle(o,d,b-width*0.52,b+width*0.52,tip);
            float t=min(t0,min(t1,t2));
            if(t<hit.t) {
                hit.t=t;vec3 n=normalize(cross(width,tip-a));if(dot(n,d)>0.0)n=-n;
                // Leaf normals bend toward sky; diffuse transmission keeps
                // thin sunlit grass legible without a glossy plastic response.
                hit.normal=normalize(n*0.55+vec3(0,0.65,0));
                float y=clamp((o.y+d.y*t-ground)/max(height,0.01),0.0,1.0);
                vec3 green=mix(vec3(0.022,0.037,0.012),vec3(0.086,0.113,0.034),y);
                vec3 straw=mix(vec3(0.061,0.048,0.022),vec3(0.18,0.153,0.075),y);
                hit.color=mix(green,straw,smoothstep(0.56,0.87,r+0.13*seed))*(0.82+0.25*r);
            }
        }
    }
    return hit;
}
