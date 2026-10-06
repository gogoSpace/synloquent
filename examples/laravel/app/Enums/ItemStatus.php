<?php

namespace App\Enums;

enum ItemStatus: string
{
    case Draft = 'draft';
    case Published = 'published';
}
