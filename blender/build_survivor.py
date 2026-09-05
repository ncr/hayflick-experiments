"""Author the survivor and export exactly the meshes the game draws.

blender -b --factory-startup --python blender/build_survivor.py
Coordinates below are game coordinates: Y up, Z forward, metres. The .blend
is converted to Blender Z up and contains named, weighted armature parts.
No downloaded model, sprite, or texture is embedded in the exported asset.
"""
import bpy
import math
import struct
from pathlib import Path
from mathutils import Vector, Matrix

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'assets/characters'
DEST.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
MATS = []

def material(name, rgb, rough=.85, matte=False):
    # Author in sRGB, export linear values, as the scene material contract asks.
    lin = tuple(c / 12.92 if c <= .04045 else ((c + .055) / 1.055)**2.4 for c in rgb)
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*lin, 1)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*lin, 1)
    bsdf.inputs['Roughness'].default_value = rough
    MATS.append((m, lin, rough, matte))
    return len(MATS)-1

SUIT = material('01 / faded vault blue twill', (.105,.245,.56), .96, True)
SEAM = material('02 / blue seam binding', (.20,.38,.68), .97, True)
DARK = material('03 / seams and rubber soles', (.065,.064,.061), .94)
PANEL = material('04 / reinforced blue cloth', (.13,.28,.59), .96, True)
DENIM = material('05 / blue suit trousers', (.095,.22,.51), .98, True)
DENIM_HI = material('06 / worn blue folds', (.20,.36,.63), .98, True)
DENIM_LO = material('07 / blue trouser seams', (.055,.13,.32), .98, True)
SKIN = material('08 / weathered skin', (.59,.425,.31), .96, True)
SKIN_HI = material('09 / cheek and knuckle planes', (.65,.49,.365), .96, True)
SKIN_LO = material('10 / eye sockets and creases', (.355,.245,.18), 1, True)
HAIR = material('11 / swept iron grey hair', (.27,.265,.245), .98, True)
HAIR_HI = material('12 / grey temples', (.43,.425,.39), .98, True)
METAL = material('13 / dull buckles', (.47,.46,.395), .54)
YELLOW = material('14 / worn vault yellow', (.93,.70,.20), .96, True)
BOOT = material('15 / scuffed boot uppers', (.135,.125,.11), .82)

# Rest origins and physical link lengths. Long links export normalized Y so
# the runtime two-bone IK can place them directly without bind-pose guesses.
PARTS = {
    'player': ((0,.91,0), 1),
    'player/chest': ((0,1.035,0), 1),
    'player/head': ((0,1.625,.015), 1),
}
for side, x in [('L',-1),('R',1)]:
    PARTS.update({
        'player/leg'+side: ((x*.103,.91,0), .445),
        'player/shin'+side: ((x*.103,.465,.015), .425),
        'player/foot'+side: ((x*.103,.065,.015), 1),
        'player/arm'+side: ((x*.225,1.405,-.005), .29),
        'player/fore'+side: ((x*.255,1.118,-.005), .265),
        'player/hand'+side: ((x*.255,.853,-.005), 1),
    })
OBJECTS = {name: [] for name in PARTS}

def mesh(name, part, verts, faces, mat, smooth=True, face_mats=None):
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.update()
    ob = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(ob)
    for m, *_ in MATS:
        data.materials.append(m)
    for i,p in enumerate(data.polygons):
        p.material_index = face_mats[i] if face_mats else mat
        p.use_smooth = smooth
    OBJECTS[part].append(ob)
    return ob

def loft(name, part, rows, mat, n=16, power=1., folds=0, smooth=True):
    # row = y, half-width, front radius, back radius, x centre, z centre.
    # Separate front/back radii shape muscle/cloth planes without stacking balls.
    v=[]
    for j,(y,rx,front,back,cx,cz) in enumerate(rows):
        for k in range(n):
            a=2*math.pi*k/n
            c,s=math.cos(a),math.sin(a)
            x=math.copysign(abs(c)**power,c)*rx
            z=math.copysign(abs(s)**power,s)*(front if s>=0 else back)
            crease=folds*math.sin(a*3+j*1.7)*math.sin(math.pi*j/(len(rows)-1))
            v.append((x*(1+crease)+cx,y,z*(1+crease)+cz))
    f=[]
    for j in range(len(rows)-1):
        for k in range(n):
            a=j*n+k;b=j*n+(k+1)%n
            f.append((a,a+n,b+n,b))
    f.extend([tuple(reversed(range(n))),tuple((len(rows)-1)*n+k for k in range(n))])
    ob=mesh(name,part,v,f,mat,smooth)
    # Recalculate actual outward normals; caps and sides have consistent winding.
    bpy.context.view_layer.objects.active=ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    ob.select_set(False)
    return ob

def panel(name,part,points,mat,thickness=.003):
    # Panels deliberately keep a crease normal at their edge.
    ob=mesh(name,part,points,[tuple(range(len(points)))],mat,False)
    sol=ob.modifiers.new('real cloth thickness','SOLIDIFY');sol.thickness=thickness
    bpy.context.view_layer.objects.active=ob
    bpy.ops.object.modifier_apply(modifier=sol.name)
    return ob

def box(name,part,lo,hi,mat,bevel=.002):
    x,y,z=lo;X,Y,Z=hi
    ob=mesh(name,part,[(x,y,z),(X,y,z),(X,Y,z),(x,Y,z),(x,y,Z),(X,y,Z),(X,Y,Z),(x,Y,Z)],
            [(0,3,2,1),(4,5,6,7),(0,1,5,4),(3,7,6,2),(0,4,7,3),(1,2,6,5)],mat,False)
    if bevel:
        mod=ob.modifiers.new('worn edge','BEVEL');mod.width=bevel;mod.segments=1
        bpy.context.view_layer.objects.active=ob;bpy.ops.object.modifier_apply(modifier=mod.name)
    return ob

def tube(name,part,points,r,mat):
    verts=[];faces=[]
    for i,p in enumerate(points):
        p=Vector(p)
        tangent=Vector(points[min(i+1,len(points)-1)])-Vector(points[max(0,i-1)])
        tangent.normalize()
        u=tangent.cross(Vector((0,0,1)))
        if u.length<.01:u=tangent.cross(Vector((1,0,0)))
        u.normalize();v=tangent.cross(u)
        for k in range(6):
            a=k*math.tau/6;verts.append(p+r*(u*math.cos(a)+v*math.sin(a)))
    for j in range(len(points)-1):
        for k in range(6):faces.append((j*6+k,j*6+(k+1)%6,(j+1)*6+(k+1)%6,(j+1)*6+k))
    return mesh(name,part,verts,faces,mat)

# A zipped, close-fitting work suit with the original game's blue/yellow
# silhouette. Cloth panels replace the asymmetric leather jacket construction.
BODY_ROWS = [
    (-.022,.151,.102,.09,0,0),(.035,.155,.109,.097,0,0),
    (.075,.16,.116,.105,0,0),(.15,.174,.125,.118,0,-.007),
    (.265,.211,.131,.125,0,-.008),(.35,.222,.115,.11,0,-.01),
    (.385,.203,.088,.096,0,-.014),(.425,.081,.059,.067,0,-.005)]
loft('Vault suit / tailored torso','player/chest',BODY_ROWS,SUIT,power=.78,folds=.018)
# Project cloth appliques onto the same analytic section surface as the torso.
def body_surface(x,y,front):
    for a,b in zip(BODY_ROWS,BODY_ROWS[1:]):
        if a[0] <= y <= b[0]:
            t=(y-a[0])/(b[0]-a[0]);r=[aa+(bb-aa)*t for aa,bb in zip(a,b)]
            rx,depth,cz=r[1],r[2 if front else 3],r[5]
            co=min(abs(x/rx)**(1/.78),.9999)
            return cz+(1 if front else -1)*(depth*(1-co*co)**(.78/2)+.0025)
    raise ValueError(y)
def cloth_rect(name,x0,x1,y0,y1,mat,front=True):
    # Tessellate across BOTH axes. A wide four-corner applique cuts a chord
    # through the curved chest and disappears into the blue cloth at its centre.
    ys=sorted({y0,y1,*[r[0] for r in BODY_ROWS if y0<r[0]<y1]})
    nx=max(1,math.ceil((x1-x0)/.009))
    xs=[x0+(x1-x0)*i/nx for i in range(nx+1)]
    verts=[(x,y,body_surface(x,y,front)) for y in ys for x in xs]
    faces=[]
    for j in range(len(ys)-1):
        for i in range(nx):
            a=j*(nx+1)+i;faces.append((a,a+1,a+nx+2,a+nx+1))
    ob=mesh(name,'player/chest',verts,faces,mat,False)
    sol=ob.modifiers.new('cloth applique thickness','SOLIDIFY');sol.thickness=.001
    bpy.context.view_layer.objects.active=ob
    bpy.ops.object.modifier_apply(modifier=sol.name)
cloth_rect('Yellow zip placket',-.019,.019,.008,.416,YELLOW)
for sign in [-1,1]:
    cloth_rect('Front shoulder yoke',min(sign*.026,sign*.154),max(sign*.026,sign*.154),.32,.351,YELLOW)
    tube('Tailored chest seam','player/chest',[(sign*.095,y,body_surface(sign*.095,y,True)+.002) for y in [.08,.15,.265,.31]],.0018,SEAM)
loft('Yellow waist band','player/chest',[(-.014,.155,.106,.094,0,0),(.019,.159,.110,.097,0,0)],YELLOW,power=.8)
loft('Yellow standing collar','player/chest',[(.416,.083,.062,.07,0,-.005),(.438,.074,.061,.065,0,0),(.453,.067,.059,.06,0,.003)],YELLOW,n=16,power=.8)
# Original, mesh-based lettering. No image atlas or external font; it follows
# the curved back and remains editable with the rest of the suit in Blender.
GLYPHS={'4':['10010','10010','10010','11111','00010','00010','00010'],
        '2':['01110','10001','00001','00010','00100','01000','11111']}
for digit,char in enumerate('42'):
    for row,line in enumerate(GLYPHS[char]):
        for col,bit in enumerate(line):
            if bit=='1':
                # Viewed from behind, +X is the left of the wearer's back.
                x1=.143-digit*.156-col*.026;x0=x1-.026
                y1=.326-row*.027;y0=y1-.027
                cloth_rect('Vault 42 / '+char,x0,x1,y0,y1,YELLOW,False)
loft('Neck / tendons','player/chest',[(.408,.06,.055,.05,0,0),(.48,.058,.059,.054,0,.004),(.505,.062,.053,.056,0,.004)],SKIN,n=12,power=.9)

# Pelvis with separate fly and belt; trouser legs continue under the hip shell.
loft('Trousers / seat','player',[(-.11,.142,.07,.087,0,0),(-.054,.164,.097,.115,0,0),(.03,.16,.101,.112,0,0),(.112,.15,.09,.10,0,0)],DENIM,power=.82)
loft('Belt','player',[(.07,.158,.101,.106,0,0),(.102,.158,.101,.106,0,0)],DARK,power=.8)
box('Buckle','player',(-.022,.071,.103),(.023,.103,.114),METAL,.003)
box('Buckle inset','player',(-.014,.077,.113),(.015,.097,.116),DARK,.001)
tube('Trouser fly','player',[(0,.065,.106),(.013,.015,.105),(.009,-.046,.101)],.0025,DENIM_LO)

# Head rings are sculpted anatomical sections, with a planar facial patch.
# No protruding eyeball balls, spherical nose, or separate beard blob.
loft('Head / cranium and jaw','player/head',[
    (-.106,.043,.064,.037,0,.019),(-.082,.069,.071,.051,0,.008),
    (-.043,.082,.073,.064,0,0),(.006,.085,.079,.073,0,-.004),
    (.05,.081,.076,.077,0,-.008),(.093,.076,.065,.072,0,-.014),
    (.126,.053,.043,.047,0,-.015),(.14,.012,.012,.012,0,-.015)],SKIN,n=16,power=.78)
for sign in [-1,1]:
    # Cheekbone to jaw contour and small deep eye socket; avoids bright cartoon eyes.
    panel('Cheek plane','player/head',[(sign*.02,-.019,.078),(sign*.06,-.011,.081),(sign*.073,-.034,.065),(sign*.047,-.062,.074),(sign*.025,-.052,.084)],SKIN_HI)
    panel('Eye socket','player/head',[(sign*.018,.025,.08),(sign*.062,.023,.07),(sign*.06,.004,.079),(sign*.02,.003,.087)],SKIN_LO)
    tube('Heavy brow','player/head',[(sign*.016,.029,.086),(sign*.038,.032,.084),(sign*.062,.026,.076)],.006,HAIR)
    tube('Eye slit','player/head',[(sign*.026,.014,.088),(sign*.045,.012,.086)],.0027,DARK)
    panel('Temple','player/head',[(sign*.078,.022,.01),(sign*.085,.068,-.008),(sign*.06,.101,-.04),(sign*.079,-.008,-.015)],HAIR_HI)
    loft('Ear','player/head',[(-.04,.009,.009,.009,sign*.087,.005),(-.02,.016,.017,.012,sign*.091,.002),(.021,.016,.016,.014,sign*.09,0),(.036,.008,.008,.007,sign*.086,0)],SKIN,n=8)
panel('Nose bridge','player/head',[(-.013,.034,.079),(.013,.034,.079),(.015,-.02,.115),(-.015,-.02,.115)],SKIN_HI)
panel('Nose left side','player/head',[(-.013,.034,.079),(-.015,-.02,.115),(-.025,-.028,.091),(-.02,.0,.08)],SKIN)
panel('Nose right side','player/head',[(.013,.034,.079),(.02,0,.08),(.025,-.028,.091),(.015,-.02,.115)],SKIN)
panel('Nose underside','player/head',[(-.015,-.02,.115),(.015,-.02,.115),(.025,-.028,.091),(-.025,-.028,.091)],SKIN_LO)
tube('Mouth','player/head',[(-.026,-.055,.086),(0,-.059,.094),(.026,-.055,.086)],.0027,SKIN_LO)
panel('Chin','player/head',[(-.028,-.064,.085),(.028,-.064,.085),(.024,-.087,.088),(-.024,-.087,.088)],SKIN_HI)
loft('Hair / swept crown','player/head',[(.068,.078,.038,.075,0,-.02),(.105,.071,.052,.066,0,-.016),(.132,.053,.046,.047,0,-.018),(.144,.023,.021,.022,0,-.019),(.146,.002,.002,.002,0,-.019)],HAIR,n=16,power=.84)
for x in [-.052,-.028,0,.028,.052]:
    tube('Swept hair ridge','player/head',[(x,.11,.028),(x*.8,.142,-.008),(x*.75,.12,-.069)],.002,HAIR_HI)

for side,sign in [('L',-1),('R',1)]:
    leg='player/leg'+side;shin='player/shin'+side;arm='player/arm'+side;fore='player/fore'+side;foot='player/foot'+side;hand='player/hand'+side
    loft('Trouser thigh '+side,leg,[
        (.035,.086,.088,.092,0,0),(-.035,.096,.10,.093,0,-.004),
        (-.14,.088,.083,.079,0,-.004),(-.25,.073,.075,.066,0,.002),
        (-.34,.065,.071,.058,0,.01),(-.39,.069,.077,.058,0,.008),
        (-.458,.061,.063,.057,0,0)],DENIM,power=.85,folds=.06)
    loft('Trouser calf '+side,shin,[
        (.019,.061,.064,.056,0,0),(-.042,.063,.059,.069,0,-.007),
        (-.125,.065,.055,.078,0,-.01),(-.205,.056,.05,.064,0,-.006),
        (-.28,.048,.047,.051,0,0),(-.327,.052,.05,.05,0,0),
        (-.37,.048,.045,.047,0,0)],DENIM,power=.85,folds=.065)
    for y,rx in [(-.295,.068),(-.359,.063),(-.394,.062)]:
        tube('Knee crease '+side,leg,[(-rx,y,.058),(0,y+.014,.08),(rx,y+.026,.052)],.0033,DENIM_HI)
    tube('Outer trouser seam '+side,leg,[(sign*.093,-.02,0),(sign*.087,-.15,.005),(sign*.07,-.31,.008),(sign*.062,-.445,0)],.0028,DENIM_LO)
    tube('Calf seam '+side,shin,[(sign*.065,0,0),(sign*.061,-.17,-.005),(sign*.047,-.34,0)],.0026,DENIM_LO)
    # Flat sole, angular toe box and separate boot shaft, not an ellipsoid shoe.
    loft('Boot sole '+side,foot,[(-.064,.058,.155,.069,0,.011),(-.045,.063,.159,.072,0,.011),(-.027,.061,.157,.07,0,.011)],DARK,n=16,power=.55)
    loft('Boot vamp '+side,foot,[(-.026,.061,.154,.067,0,.012),(.005,.06,.15,.065,0,.01),(.043,.052,.119,.058,0,.003),(.09,.045,.055,.053,0,0),(.146,.047,.049,.05,0,0)],BOOT,n=16,power=.65)
    tube('Toe stitching '+side,foot,[(-.051,-.007,.084),(-.038,.027,.105),(0,.031,.112),(.038,.027,.105),(.051,-.007,.084)],.002,SEAM)
    for j in range(4):
        y=.033+j*.022;z=.089-j*.012
        tube('Boot lace '+side,foot,[(-.028,y,z),(.025,y+.007,z)],.0022,DARK)
    # Matching fitted sleeves with articulated elbows and yellow cuffs.
    bare=False
    loft('Upper arm '+side,arm,[(.027,.055,.059,.06,0,0),(-.012,.078,.075,.074,0,0),(-.075,.077,.077,.075,0,0),(-.155,.064,.068,.061,0,0),(-.238,.05,.055,.05,0,0),(-.30,.048,.05,.046,0,0)],SKIN if bare else SUIT,power=.87,folds=.0 if bare else .06)
    loft('Forearm '+side,fore,[(.016,.05,.05,.046,0,0),(-.055,.052,.054,.049,0,0),(-.13,.043,.043,.039,0,0),(-.225,.033,.035,.03,0,0),(-.273,.032,.033,.029,0,0)],SKIN if bare else SUIT,power=.87,folds=.0 if bare else .055)
    if not bare:
        loft('Suit shoulder reinforcement',arm,[(.043,.04,.045,.046,0,0),(.013,.079,.08,.077,0,0),(-.035,.084,.083,.08,0,0),(-.079,.078,.078,.074,0,0)],PANEL,n=12,power=.7)
        for y in [-.145,-.213,-.254]:
            tube('Sleeve compression '+side,fore,[(-.035,y,.027),(0,y+.012,.041),(.034,y+.024,.027)],.003,SEAM)
        loft('Yellow sleeve cuff',fore,[(-.226,.036,.038,.033,0,0),(-.262,.036,.038,.033,0,0)],YELLOW,n=12,power=.8)
    else:
        tube('Deltoid plane',arm,[(sign*.038,-.069,.061),(sign*.045,-.108,.057),(sign*.024,-.167,.056)],.0025,SKIN_HI)
    # Anatomical palm + four curled fingers and an opposed thumb. Fingerless
    # glove has a real cuff and knuckle openings, useful at close camera zoom.
    loft('Palm '+side,hand,[(.004,.029,.021,.021,0,0),(-.027,.038,.025,.024,0,0),(-.064,.036,.025,.023,0,.003),(-.083,.028,.021,.018,0,.007)],SKIN,n=12,power=.7)
    box('Glove back '+side,hand,(-.035,-.065,-.027),(.035,-.012,-.019),BOOT,.004)
    for j in range(4):
        x=(j-1.5)*.016
        tube('Curled finger '+side,hand,[(x,-.062,.002),(x,-.091,.012),(x,-.09,.03),(x,-.071,.034)],.008,SKIN_HI)
    tube('Thumb '+side,hand,[(-sign*.031,-.027,.008),(-sign*.047,-.055,.024),(-sign*.035,-.07,.036)],.011,SKIN)

# Export Blender-computed split normals and indexed triangles in local game
# coordinates before the authoring scene is placed into its upright rest pose.
with (DEST/'survivor.mesh').open('wb') as f:
    f.write(b'HFCHAR01')
    f.write(struct.pack('<II',len(MATS),len(PARTS)))
    for _,rgb,rough,matte in MATS:f.write(struct.pack('<5fI',*rgb,1.,rough,4 if matte else 0))
    for part,(_,length) in PARTS.items():
        groups={}
        for ob in OBJECTS[part]:
            me=ob.data;me.calc_loop_triangles()
            for tri in me.loop_triangles:
                group=groups.setdefault(tri.material_index,[])
                coords=[me.vertices[i].co for i in tri.vertices]
                if (coords[1]-coords[0]).cross(coords[2]-coords[0]).length_squared<1e-15:continue
                for li,vi in zip(tri.loops,tri.vertices):
                    p=me.vertices[vi].co;n=me.corner_normals[li].vector
                    # Inverse-transpose compensates the normalized bind link.
                    nn=Vector((n.x,n.y*length,n.z)).normalized()
                    group.append((p.x,p.y/length,p.z,*nn))
        name=part.encode();f.write(struct.pack('<I',len(name)));f.write(name)
        f.write(struct.pack('<I',len(groups)))
        for mat,vs in groups.items():
            f.write(struct.pack('<II',mat,len(vs)))
            for v in vs:f.write(struct.pack('<6f',*v))

# Genuine editable Blender armature. Each mesh is weighted to its named link;
# overlapping garment cuffs conceal articulation seams at the game pixel size.
C=Matrix(((1,0,0,0),(0,0,-1,0),(0,1,0,0),(0,0,0,1)))
arm_data=bpy.data.armatures.new('Survivor skeleton')
arm=bpy.data.objects.new('Survivor / animation rig',arm_data)
bpy.context.collection.objects.link(arm)
bpy.context.view_layer.objects.active=arm;arm.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
for part,(origin,length) in PARTS.items():
    b=arm_data.edit_bones.new(part)
    b.head=C@Vector(origin)
    axis=Vector((0,-min(length,.25),0)) if length!=1 else Vector((0,.12,0))
    b.tail=C@(Vector(origin)+axis)
bpy.ops.object.mode_set(mode='OBJECT')
for part,(origin,_) in PARTS.items():
    for ob in OBJECTS[part]:
        ob.data.transform(C@Matrix.Translation(Vector(origin)))
        vg=ob.vertex_groups.new(name=part);vg.add(list(range(len(ob.data.vertices))),1.,'REPLACE')
        mod=ob.modifiers.new('Survivor skeleton','ARMATURE');mod.object=arm
        ob.parent=arm
arm.show_in_front=True
bpy.context.scene.render.fps=60
bpy.context.scene.frame_end=60
bpy.context.scene.world.color=(.18,.18,.18)
bpy.context.scene['runtime_animation']='Distance-paced stance IK, torso counter-rotation and heel/toe roll: crates/rt-viewer/src/survivor.rs'
bpy.context.scene['reference']='Fallout 2 blue vault suit, Vault 42; original editable meshes and lettering, no imported game assets.'
# Import solved runtime poses into real Blender actions for visual editing and
# review. Run the explicit Rust export harness after changing the gait.
motion=ROOT/'output/player-reference/motion.txt'
if motion.exists():
    arm.animation_data_create()
    actions={}
    for line in motion.read_text().splitlines():
        clip,frame,part,*values=line.split()
        if clip not in actions:
            action=bpy.data.actions.new(clip)
            action.use_fake_user=True
            actions[clip]=action
        arm.animation_data.action=actions[clip]
        a=list(map(float,values))
        pose=Matrix([a[i::4] for i in range(4)])
        origin,length=PARTS[part]
        deform=pose@Matrix.Diagonal((1,1/length,1,1))@Matrix.Translation(-Vector(origin))
        pb=arm.pose.bones[part]
        pb.rotation_mode='QUATERNION'
        pb.matrix=C@deform@C.inverted()@pb.bone.matrix_local
        for channel in ['location','rotation_quaternion','scale']:
            pb.keyframe_insert(data_path=channel,frame=int(frame),group=part)
    arm.animation_data.action=actions['Walk']
    bpy.context.scene.frame_end=180
    bpy.context.scene.frame_set(50)
    bpy.context.view_layer.update()
    for line in motion.read_text().splitlines():
        clip,frame,part,*values=line.split()
        if clip!='Walk' or frame!='50':continue
        a=list(map(float,values));pose=Matrix([a[i::4] for i in range(4)])
        origin,length=PARTS[part]
        deform=pose@Matrix.Diagonal((1,1/length,1,1))@Matrix.Translation(-Vector(origin))
        pb=arm.pose.bones[part]
        expected=C@deform@C.inverted()@pb.bone.matrix_local
        error=max(abs(pb.matrix[r][c]-expected[r][c]) for r in range(4) for c in range(4))
        assert error<.0001,(part,'Blender/runtime pose mismatch',error)
    print('Blender Walk frame 50 matches every runtime bone transform')
# A useful initial viewport when opening the source model.
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='VIEW_3D':
            space=area.spaces.active
            space.shading.color_type='MATERIAL'
            space.region_3d.view_distance=3.2
            space.region_3d.view_location=(0,0,.9)
bpy.context.preferences.filepaths.save_version=0
bpy.ops.wm.save_as_mainfile(filepath=str(DEST/'survivor.blend'),compress=True)
print('Exported',sum(len(ob.data.polygons) for obs in OBJECTS.values() for ob in obs),'polygons;', (DEST/'survivor.mesh').stat().st_size,'runtime bytes')
