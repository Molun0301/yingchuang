#include <stdint.h>
#include <math.h>

#ifdef _WIN32
#define API __declspec(dllexport)
#else
#define API __attribute__((visibility("default")))
#endif

static float clamp(float value, float low, float high) {
    return value < low ? low : value > high ? high : value;
}

/* 采用左上边规则，使相邻三角形共用的边只绘制一次。 */
static int inclusive(const float *a, const float *b, float determinant) {
    float dx=b[0]-a[0], dy=b[1]-a[1];
    if (determinant<0) { dx=-dx; dy=-dy; }
    return dy<0 || (dy==0 && dx>0);
}

API void raster_mesh(const float *points, const float *uv, const int32_t *triangles,
                     int triangle_count, const uint8_t *texture, int tw, int th,
                     float *frame, int width, int height) {
    for (int triangle=0;triangle<triangle_count;triangle++) {
        int ia=triangles[triangle*3], ib=triangles[triangle*3+1], ic=triangles[triangle*3+2];
        const float *a=points+ia*2, *b=points+ib*2, *c=points+ic*2;
        float ax=b[0]-a[0], ay=b[1]-a[1], bx=c[0]-a[0], by=c[1]-a[1];
        float determinant=ax*by-ay*bx;
        if (fabsf(determinant)<1e-7f) continue;
        int x0=(int)clamp(floorf(fminf(a[0],fminf(b[0],c[0]))),0,(float)width);
        int y0=(int)clamp(floorf(fminf(a[1],fminf(b[1],c[1]))),0,(float)height);
        int x1=(int)clamp(ceilf(fmaxf(a[0],fmaxf(b[0],c[0]))),0,(float)width);
        int y1=(int)clamp(ceilf(fmaxf(a[1],fmaxf(b[1],c[1]))),0,(float)height);
        int edge_u=inclusive(c,a,determinant), edge_v=inclusive(a,b,determinant), edge_w=inclusive(b,c,determinant);
        for (int y=y0;y<y1;y++) for (int x=x0;x<x1;x++) {
            float dx=x+.5f-a[0], dy=y+.5f-a[1];
            float u=(dx*by-dy*bx)/determinant, v=(dy*ax-dx*ay)/determinant, w=1-u-v;
            if (!(u>1e-6f || (u>=-1e-6f && edge_u)) ||
                !(v>1e-6f || (v>=-1e-6f && edge_v)) ||
                !(w>1e-6f || (w>=-1e-6f && edge_w))) continue;
            float tx=clamp((uv[ia*2]*w+uv[ib*2]*u+uv[ic*2]*v)*tw-.5f,0,tw-1);
            float ty=clamp((uv[ia*2+1]*w+uv[ib*2+1]*u+uv[ic*2+1]*v)*th-.5f,0,th-1);
            int sx=(int)tx, sy=(int)ty, nx=sx+1<tw?sx+1:sx, ny=sy+1<th?sy+1:sy;
            float fx=tx-sx, fy=ty-sy, sample[4];
            for (int channel=0;channel<4;channel++) {
                float top=texture[(sy*tw+sx)*4+channel]*(1-fx)+texture[(sy*tw+nx)*4+channel]*fx;
                float bottom=texture[(ny*tw+sx)*4+channel]*(1-fx)+texture[(ny*tw+nx)*4+channel]*fx;
                sample[channel]=(top*(1-fy)+bottom*fy)/255;
            }
            float *pixel=frame+(y*width+x)*4, alpha=sample[3];
            for(int channel=0;channel<3;channel++)pixel[channel]=sample[channel]*alpha+pixel[channel]*(1-alpha);
            pixel[3]=alpha+pixel[3]*(1-alpha);
        }
    }
}
